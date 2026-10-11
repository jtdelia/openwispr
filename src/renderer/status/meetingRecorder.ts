import type { MeetingChunk } from '../../shared/api'
import type { TranscriptSource } from '../../shared/types'
import { encodeWav, SAMPLE_RATE, workletUrl } from './recorder'
import { EchoDetector, silenceSpans } from './echoDetector'
import { MIN_SPEECH_MS, SpeechChunker, speechMs, type SpeechChunk } from './speechChunker'

const FLUSH_TIMEOUT_MS = 300
/** Mic chunks wait this long past their end for echo decisions; must exceed the detector's hangover. */
const ECHO_HOLD_MS = 3000

interface Capture {
  session: number
  source: TranscriptSource
  stream: MediaStream
  context: AudioContext
  node: AudioWorkletNode
  chunker: SpeechChunker
  /** Ms after the session started that this capture's first sample was recorded. */
  offsetMs: number
  /** `offsetMs` in samples, so both captures share one sample clock for echo detection. */
  offsetSamples: number
  received: number
}

interface PendingChunk {
  capture: Capture
  chunk: SpeechChunk
}

/**
 * Records the microphone and system audio as two separate 16 kHz streams, so the transcript can tell
 * the user apart from everyone else, and hands back speech chunks as they complete.
 */
export class MeetingRecorder {
  private captures: Capture[] = []
  private session: number | null = null
  private startedAt = 0
  private echo: EchoDetector | null = null
  private pendingMic: PendingChunk[] = []

  constructor(private readonly onChunk: (chunk: MeetingChunk) => void) {}

  /** Throws if the microphone fails; system audio is optional and its failure is returned. */
  async start(session: number, deviceId: string): Promise<{ systemAudioError: string | null }> {
    await this.stop()
    this.session = session
    this.startedAt = Date.now()
    this.echo = new EchoDetector({ sampleRate: SAMPLE_RATE })
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        // `true` only cancels audio this app plays; "all" also removes the call playing from other apps.
        echoCancellation: { ideal: 'all' },
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    await this.add('mic', mic, session)

    let systemAudioError: string | null = null
    try {
      await this.add('system', await systemAudioStream(), session)
    } catch (error) {
      systemAudioError = error instanceof Error ? error.message : String(error)
    }
    return { systemAudioError }
  }

  /** Emits the final partial chunks, then releases both streams. */
  async stop(): Promise<void> {
    this.session = null
    const captures = this.captures
    this.captures = []
    await Promise.all(captures.map((capture) => this.finish(capture)))
    this.releaseMic(true)
    if (this.echo) console.info('Meeting echo detector', this.echo.stats)
    this.echo = null
  }

  cut(session: number, source: TranscriptSource): void {
    if (session !== this.session) return
    this.captures.find((c) => c.source === source)?.chunker.requestCut()
  }

  private async add(source: TranscriptSource, stream: MediaStream, session: number): Promise<void> {
    if (this.session !== session) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    await context.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(context, 'openwispr-capture')
    const offsetMs = Date.now() - this.startedAt
    const capture: Capture = {
      session,
      source,
      stream,
      context,
      node,
      chunker: new SpeechChunker({ sampleRate: SAMPLE_RATE }),
      offsetMs,
      offsetSamples: Math.round((offsetMs / 1000) * SAMPLE_RATE),
      received: 0,
    }
    node.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
      if (typeof event.data === 'string') return
      this.echo?.push(source, event.data, capture.offsetSamples + capture.received)
      capture.received += event.data.length
      const chunk = capture.chunker.push(event.data)
      if (chunk) this.emit(capture, chunk)
      this.releaseMic(false)
    }
    context.createMediaStreamSource(stream).connect(node)
    node.connect(context.destination)
    // Stopped while the worklet was loading.
    if (this.session !== session) await this.finish(capture)
    else this.captures.push(capture)
  }

  private async finish(capture: Capture): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, FLUSH_TIMEOUT_MS)
      capture.node.port.addEventListener('message', (event) => {
        if (event.data === 'flushed') {
          clearTimeout(timeout)
          resolve()
        }
      })
      capture.node.port.postMessage('flush')
    })
    const chunk = capture.chunker.flush()
    if (chunk) this.emit(capture, chunk)
    capture.node.port.onmessage = null
    capture.stream.getTracks().forEach((t) => t.stop())
    void capture.context.close()
  }

  private emit(capture: Capture, chunk: SpeechChunk): void {
    if (capture.source === 'mic') {
      this.pendingMic.push({ capture, chunk })
      this.releaseMic(false)
    } else {
      this.send(capture, chunk)
    }
  }

  /** Sends held mic chunks, in order, once the echo detector has decided on them. */
  private releaseMic(all: boolean): void {
    const hold = (ECHO_HOLD_MS / 1000) * SAMPLE_RATE
    const mic = this.captures.find((c) => c.source === 'mic')
    const hasSystem = this.captures.some((c) => c.source === 'system')
    while (this.pendingMic.length > 0) {
      const { capture, chunk } = this.pendingMic[0]!
      const start = capture.offsetSamples + chunk.startSample
      const end = capture.offsetSamples + chunk.endSample
      const micEnd = mic ? mic.offsetSamples + mic.received : Number.POSITIVE_INFINITY
      const decided = (this.echo?.analyzedThrough ?? Number.POSITIVE_INFINITY) >= end + hold
      // A stalled system stream must not hold the user's speech forever.
      if (!all && hasSystem && !decided && micEnd < end + 2 * hold) return
      this.pendingMic.shift()
      const spans = this.echo?.spans(start, end) ?? []
      if (spans.length > 0) {
        silenceSpans(chunk.samples, start, spans)
        if (speechMs(chunk.samples, SAMPLE_RATE) < MIN_SPEECH_MS) continue
      }
      this.send(capture, chunk)
    }
  }

  private send(capture: Capture, chunk: SpeechChunk): void {
    const startMs = capture.offsetMs + capture.chunker.msAt(chunk.startSample)
    this.onChunk({
      session: capture.session,
      source: capture.source,
      startMs,
      endMs: capture.offsetMs + capture.chunker.msAt(chunk.endSample),
      wallClockMs: this.startedAt + startMs,
      wav: encodeWav(chunk.samples),
    })
  }
}

/** The main process answers `getDisplayMedia` with a system-audio loopback device (see systemAudio.ts). */
async function systemAudioStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false })
  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }
  const [track] = stream.getAudioTracks()
  if (!track || track.readyState === 'ended') {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      'System audio is unavailable. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording.',
    )
  }
  return stream
}
