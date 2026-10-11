import { Channel, type MeetingChunk, type MeetingRecorderEvent } from '../shared/api'
import { appSpeaker, speakerKey, speakerLabel, voiceId, voiceSpeaker } from '../shared/speakers'
import { MIN_SUMMARY_WORDS } from '../shared/summaryState'
import { isLocalEndpoint, type NotetakerState, type ProviderConfig, type TranscriptSource } from '../shared/types'
import {
  chunkPrompt,
  formatTranscript,
  isLikelyHallucination,
  relabelSummary,
  sanitizeSummary,
  sanitizeTitle,
  summaryMessages,
  titleMessages,
} from './meetingProcessing'
import type { Helper, SpeakersReport } from './helper'
import type { MeetingStore } from './meetingStore'
import { complete, transcribeSegments, type TranscriptSegment } from './providers'
import { SpeakerIdentityMap } from './speakerIdentity'
import { SelfName, SpeakerTimeline } from './speakerTimeline'
import type { Store } from './store'
import { applyReplacements, transcriptionPrompt } from './textProcessing'
import { VoiceBank } from './voices'
import type { Windows } from './windows'

const STOP_FLUSH_TIMEOUT_MS = 5000
const RETRY_DELAY_MS = 1500
const SUMMARY_TIMEOUT_MS = 180_000
const TITLE_ATTEMPTS = 3
const TITLE_TRANSCRIPT_CHARS = 12_000
/**
 * How Google Meet marks tiles: a class on the audio indicator present only while that participant
 * talks, and controls that only the user's own tile has. Meet's class names are minified and change.
 */
const MEET_TILE_MARKERS = {
  speakingClasses: ['BlxGDf'],
  selfLabels: ['Backgrounds and effects', 'Reframe'],
}

interface Segment {
  session: number
  meetingId: string
  baseRecordedMs: number
  queues: Record<TranscriptSource, Promise<void>>
  previousText: Record<TranscriptSource, string>
  timeline: SpeakerTimeline
}

/** What the controller has learned about a meeting's voices; kept across resumed recordings. */
interface SpeakerMemory {
  voices: VoiceBank
  identities: SpeakerIdentityMap
  self: SelfName
  lastCallSpeaker: string | null
}

/** Records meetings (microphone plus system audio), transcribes them in chunks, then titles and summarizes. */
export class NotetakerController {
  private state: NotetakerState = { kind: 'idle' }
  private session = 0
  private segment: Segment | null = null
  private onStopped: (() => void) | null = null
  private readonly memories = new Map<string, SpeakerMemory>()
  private lastSpeaking: string[] = []

  constructor(
    private readonly helper: Helper,
    private readonly store: Store,
    private readonly meetings: MeetingStore,
    private readonly windows: Windows,
    private readonly onStateChange: (state: NotetakerState) => void,
  ) {}

  get current(): NotetakerState {
    return this.state
  }

  start(meetingId: string): void {
    if (this.state.kind === 'recording' && this.state.meetingId === meetingId) return
    if (this.state.kind !== 'idle') throw new Error('Another meeting is still being recorded')
    const meeting = this.meetings.get(meetingId)
    if (!meeting) throw new Error('Meeting not found')
    const { transcription, microphoneId } = this.store.settings
    if (!transcription.apiKey && !isLocalEndpoint(transcription.baseUrl)) {
      throw new Error('Add a transcription API key in Settings')
    }

    const session = ++this.session
    this.segment = {
      session,
      meetingId,
      baseRecordedMs: meeting.recordedMs,
      queues: { mic: Promise.resolve(), system: Promise.resolve() },
      previousText: { mic: '', system: '' },
      timeline: new SpeakerTimeline(),
    }
    this.setState({
      kind: 'recording',
      meetingId,
      startedAt: Date.now(),
      baseRecordedMs: meeting.recordedMs,
      systemAudio: { kind: 'starting' },
      speakers: { platform: null, speaking: [] },
    })
    this.helper.request('startSpeakerPolling', MEET_TILE_MARKERS).catch((error: unknown) => {
      console.warn('[notetaker] speaker detection unavailable', error)
    })
    this.windows.flowBar.webContents.send(Channel.meetingRecorderCommand, {
      type: 'start',
      session,
      deviceId: microphoneId,
    })
  }

  async stop(): Promise<void> {
    if (this.state.kind !== 'recording') return
    const { meetingId, startedAt, baseRecordedMs } = this.state
    const segment = this.segment
    this.meetings.update(meetingId, { recordedMs: baseRecordedMs + (Date.now() - startedAt) })
    this.setState({ kind: 'finishing', meetingId })
    this.stopSpeakerPolling()

    const flushed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_FLUSH_TIMEOUT_MS)
      this.onStopped = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this.windows.flowBar.webContents.send(Channel.meetingRecorderCommand, { type: 'stop', session: this.session })
    await flushed
    this.onStopped = null
    if (segment) await Promise.all([segment.queues.mic, segment.queues.system])

    this.segment = null
    this.setState({ kind: 'idle' })
    this.broadcastMeetings()
    await this.afterMeeting(meetingId)
  }

  /** Stops without waiting for pending audio, e.g. when the meeting being recorded is deleted. */
  discard(meetingId: string): void {
    this.memories.delete(meetingId)
    if (this.state.kind === 'idle' || this.state.meetingId !== meetingId) return
    this.stopSpeakerPolling()
    this.windows.flowBar.webContents.send(Channel.meetingRecorderCommand, { type: 'stop', session: this.session })
    this.session++
    this.segment = null
    this.onStopped?.()
    this.setState({ kind: 'idle' })
  }

  handleRecorderEvent(event: MeetingRecorderEvent): void {
    if (event.session !== this.session) return
    switch (event.type) {
      case 'started':
        if (this.state.kind !== 'recording') return
        this.setState({
          ...this.state,
          systemAudio:
            event.systemAudioError === null
              ? { kind: 'capturing' }
              : { kind: 'unavailable', reason: event.systemAudioError },
        })
        return
      case 'error':
        if (this.state.kind === 'idle') return
        console.error('[notetaker] recorder failed', event.message)
        this.stopSpeakerPolling()
        this.segment = null
        this.setState({ kind: 'idle', error: `Couldn't start recording: ${event.message}` })
        return
      case 'stopped':
        this.onStopped?.()
        return
      default: {
        const unreachable: never = event
        throw new Error(`unhandled meeting recorder event ${JSON.stringify(unreachable)}`)
      }
    }
  }

  handleSpeakers(report: SpeakersReport): void {
    const segment = this.segment
    if (this.state.kind !== 'recording' || !segment) return
    const self = this.memory(segment.meetingId).self.current
    const others = report.speaking.filter((name) => name !== self)
    const changed = report.speaking.join('\n') !== this.lastSpeaking.join('\n')
    this.lastSpeaking = report.speaking
    segment.timeline.push({ at: report.timestamp, speaking: report.speaking })
    this.setState({ ...this.state, speakers: { platform: report.platform, speaking: others } })
    if (changed) {
      // Cutting the microphone too keeps its chunks to one turn, which is how the user's own name is learned.
      for (const source of ['mic', 'system'] as const) {
        this.windows.flowBar.webContents.send(Channel.meetingRecorderCommand, { type: 'cut', session: segment.session, source })
      }
    }
  }

  /** Saves the names the user gave speakers and relabels the existing summary to match. */
  setSpeakerNames(meetingId: string, names: Record<string, string>): void {
    const detail = this.meetings.detail(meetingId)
    if (!detail) return
    const { userName } = this.store.settings
    const keys = [...new Set(detail.transcript.map(speakerKey))]
    const renames = keys.map((key) => ({
      from: speakerLabel(key, detail.speakerNames, userName),
      to: speakerLabel(key, names, userName),
    }))
    this.meetings.update(meetingId, {
      speakerNames: names,
      ...(detail.summary !== null ? { summary: relabelSummary(detail.summary, renames) } : {}),
    })
    this.broadcastMeetings()
  }

  handleChunk(chunk: MeetingChunk): void {
    const segment = this.segment
    if (!segment || chunk.session !== segment.session) return
    segment.queues[chunk.source] = segment.queues[chunk.source].then(() =>
      this.transcribeChunk(segment, chunk).catch((error: unknown) => {
        console.error('[notetaker] chunk transcription failed', error)
        if (this.state.kind === 'recording' && this.segment === segment) {
          this.setState({ ...this.state, error: error instanceof Error ? error.message : String(error) })
        }
      }),
    )
  }

  private async transcribeChunk(segment: Segment, chunk: MeetingChunk): Promise<void> {
    const { transcription, userName } = this.store.settings
    const { dictionary } = this.store
    const memory = this.memory(segment.meetingId)
    const prompt = chunkPrompt(transcriptionPrompt(dictionary, userName), segment.previousText[chunk.source])
    const wav = Buffer.from(chunk.wav)
    const known = chunk.source === 'system' ? memory.voices.knownSpeakers() : undefined
    const run = () => transcribeSegments(transcription, wav, chunk.endMs - chunk.startMs, prompt, known)
    const parts = await run().catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      return run()
    })
    const voices = chunk.source === 'system' ? memory.voices.assign(parts, wav) : new Map<string, number>()

    let appended = false
    for (const part of parts) {
      if (isLikelyHallucination(part.text)) continue
      const text = applyReplacements(part.text, dictionary)
      if (chunk.source === 'mic') {
        const from = chunk.wallClockMs + part.startMs
        memory.self.vote(segment.timeline.dominant(from, chunk.wallClockMs + part.endMs, memory.self.remoteNames))
      }
      const speaker = chunk.source === 'system' ? this.attribute(segment, memory, chunk, part, voices) : null
      const startMs = segment.baseRecordedMs + chunk.startMs
      const entry = this.meetings.appendTranscript(segment.meetingId, {
        source: chunk.source,
        text,
        startMs: startMs + part.startMs,
        endMs: startMs + Math.max(part.startMs, part.endMs),
        ...(speaker ? { speaker } : {}),
      })
      if (!entry) return
      segment.previousText[chunk.source] = `${segment.previousText[chunk.source]} ${text}`.slice(-400)
      appended = true
    }
    if (!appended) return
    if (this.state.kind === 'recording' && this.state.error) this.setState({ ...this.state, error: undefined })
    this.broadcastMeetings()
  }

  /**
   * Who said a call-audio segment: whoever the meeting app showed talking through it, else the name the
   * segment's voice has earned from earlier segments, else just the voice.
   */
  private attribute(
    segment: Segment,
    memory: SpeakerMemory,
    chunk: MeetingChunk,
    part: TranscriptSegment,
    voices: Map<string, number>,
  ): string | null {
    const from = chunk.wallClockMs + part.startMs
    const self = memory.self.current
    const credit = segment.timeline.credit(from, chunk.wallClockMs + part.endMs, {
      ignore: self ? [self] : [],
      previous: memory.lastCallSpeaker,
      isRemote: (name) => memory.self.isRemote(name),
    })
    if (credit?.clear) memory.self.heardOnCall(credit.name)
    const shown = credit?.name ?? null
    const voice = part.speaker === null ? undefined : voices.get(part.speaker)
    const observed = credit?.clear ? credit.name : null
    const named = voice === undefined ? shown : (memory.identities.resolve(voiceSpeaker(voice), observed, from) ?? shown)
    if (named) memory.lastCallSpeaker = named
    if (named) return appSpeaker(named)
    return voice === undefined ? null : voiceSpeaker(voice)
  }

  private memory(meetingId: string): SpeakerMemory {
    let memory = this.memories.get(meetingId)
    if (!memory) {
      const used = this.meetings.transcript(meetingId).map((e) => (e.speaker ? (voiceId(e.speaker) ?? 0) : 0))
      memory = {
        voices: new VoiceBank(Math.max(0, ...used) + 1),
        identities: new SpeakerIdentityMap(),
        self: new SelfName(),
        lastCallSpeaker: null,
      }
      this.memories.set(meetingId, memory)
    }
    return memory
  }

  private stopSpeakerPolling(): void {
    this.helper.request('stopSpeakerPolling').catch(() => undefined)
  }

  private async afterMeeting(meetingId: string): Promise<void> {
    const meeting = this.meetings.get(meetingId)
    if (!meeting) return
    if (!meeting.title.trim()) await this.generateTitle(meetingId)
    if (meeting.summary === null && meeting.transcriptWords >= MIN_SUMMARY_WORDS) {
      await this.generateSummary(meetingId)
    }
  }

  private async generateTitle(meetingId: string): Promise<void> {
    const llm = this.llm()
    const detail = this.meetings.detail(meetingId)
    if (!llm || !detail) return
    const transcript = formatTranscript(detail.transcript, detail.speakerNames, this.store.settings.userName).slice(
      0,
      TITLE_TRANSCRIPT_CHARS,
    )
    if (!transcript && !detail.notes.trim()) return
    for (let attempt = 1; attempt <= TITLE_ATTEMPTS; attempt++) {
      try {
        const title = sanitizeTitle(await complete(llm, titleMessages({ transcript, notes: detail.notes }), { label: 'Title' }))
        // The user may have typed a title while the request was in flight.
        if (title && !this.meetings.get(meetingId)?.title.trim()) {
          this.meetings.update(meetingId, { title })
          this.broadcastMeetings()
        }
        return
      } catch (error) {
        console.error(`[notetaker] title attempt ${attempt} failed`, error)
      }
    }
  }

  async generateSummary(meetingId: string): Promise<void> {
    const meeting = this.meetings.get(meetingId)
    if (!meeting || meeting.summaryGenerating) return
    const llm = this.llm()
    if (!llm) {
      this.meetings.update(meetingId, { summaryError: 'Set up an AI cleanup model in Settings to generate summaries' })
      this.broadcastMeetings()
      return
    }

    this.meetings.setGenerating(meetingId, true)
    this.meetings.update(meetingId, { summaryError: null })
    this.broadcastMeetings()
    try {
      const detail = this.meetings.detail(meetingId)
      if (!detail) return
      const { userName } = this.store.settings
      const output = await complete(
        llm,
        summaryMessages({
          title: detail.title,
          transcript: formatTranscript(detail.transcript, detail.speakerNames, userName),
          notes: detail.notes,
          userName,
          dictionary: this.store.dictionary,
          recordedAt: detail.createdAt,
        }),
        { label: 'Summary', timeoutMs: SUMMARY_TIMEOUT_MS },
      )
      const summary = sanitizeSummary(output)
      if (!summary) throw new Error('The model returned an empty summary')
      this.meetings.update(meetingId, { summary, summaryRecordedMs: detail.recordedMs, summaryError: null })
    } catch (error) {
      console.error('[notetaker] summary failed', error)
      this.meetings.update(meetingId, { summaryError: error instanceof Error ? error.message : String(error) })
    } finally {
      this.meetings.setGenerating(meetingId, false)
      this.broadcastMeetings()
    }
  }

  /** Summaries and titles use the dictation cleanup model, whether or not cleanup is enabled for dictation. */
  private llm(): ProviderConfig | null {
    const { cleanup } = this.store.settings
    if (!cleanup.model.trim()) return null
    return cleanup.apiKey || isLocalEndpoint(cleanup.baseUrl) ? cleanup : null
  }

  private setState(state: NotetakerState): void {
    const kindChanged = state.kind !== this.state.kind
    this.state = state
    this.windows.broadcast(Channel.dataChanged, 'notetaker')
    if (kindChanged) this.onStateChange(state)
  }

  private broadcastMeetings(): void {
    this.windows.broadcast(Channel.dataChanged, 'meetings')
  }
}
