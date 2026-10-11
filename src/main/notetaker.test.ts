import { describe, expect, it, vi } from 'vitest'
import type { MeetingChunk } from '../shared/api'
import type { Meeting, Settings, TranscriptEntry } from '../shared/types'
import type { Helper } from './helper'
import type { MeetingStore } from './meetingStore'
import type { ModelProcessMessage, ModelProcessTransport, ModelRequest } from './modelProcess'
import { Models, type ModelSettings } from './models'
import { NotetakerController } from './notetaker'
import type { Store } from './store'
import type { Windows } from './windows'

const MEETING_ID = 'm1'
const T0 = 1_700_000_000_000

function silentWav(durationMs: number): ArrayBuffer {
  const bytes = Math.round((16_000 * durationMs) / 1000) * 2
  const wav = Buffer.alloc(44 + bytes)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + bytes, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16_000, 24)
  wav.write('data', 36)
  wav.writeUInt32LE(bytes, 40)
  return new Uint8Array(wav).buffer
}

/** A model process whose speech-to-text model answers every transcription with `segments` (seconds). */
function speechProcess(segments: Array<{ start: number; end: number; text: string }>): ModelProcessTransport {
  return {
    start(handlers) {
      return {
        send(request: ModelRequest) {
          const result = request.type === 'transcribe' ? { text: segments.map((s) => s.text).join(''), segments } : {}
          queueMicrotask(() => handlers.message({ type: 'response', id: request.id, result } as ModelProcessMessage))
        },
        stop() {
          queueMicrotask(() => handlers.exit(null))
        },
      }
    },
  }
}

function notetaker(settings: ModelSettings, deps: { transport?: ModelProcessTransport; fetch?: typeof globalThis.fetch } = {}) {
  const transcript: TranscriptEntry[] = []
  const meeting: Meeting = {
    id: MEETING_ID,
    title: 'Sync',
    createdAt: T0,
    modifiedAt: T0,
    notes: '',
    summary: null,
    summaryRecordedMs: 0,
    summaryError: null,
    summaryGenerating: false,
    recordedMs: 0,
    transcriptWords: 0,
    speakerNames: {},
  }
  const meetings = {
    get: (id: string) => (id === MEETING_ID ? meeting : null),
    update: (_id: string, patch: Partial<Meeting>) => Object.assign(meeting, patch),
    transcript: () => transcript,
    appendTranscript: (_id: string, entry: Omit<TranscriptEntry, 'id'>) => {
      const full = { ...entry, id: String(transcript.length) }
      transcript.push(full)
      return full
    },
  }
  const store = { settings: { ...settings, microphoneId: '', userName: '' } as Settings, dictionary: [] }
  const helper = { request: async () => undefined }
  const windows = { flowBar: { webContents: { send: () => undefined } }, broadcast: () => undefined }
  const models = new Models({
    fetch: deps.fetch ?? globalThis.fetch,
    settings: () => settings,
    transport: deps.transport ?? speechProcess([]),
    modelsDir: '/nonexistent',
  })
  const controller = new NotetakerController(
    helper as unknown as Helper,
    store as unknown as Store,
    models,
    meetings as unknown as MeetingStore,
    windows as unknown as Windows,
    () => undefined,
  )
  controller.start(MEETING_ID)
  const chunk = (startMs: number, durationMs: number): MeetingChunk => ({
    session: 1,
    source: 'system',
    startMs,
    endMs: startMs + durationMs,
    wallClockMs: T0 + startMs,
    wav: silentWav(durationMs),
  })
  return { controller, transcript, chunk }
}

const CHAT_ENDPOINT = { kind: 'endpoint', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', apiKey: 'k' } as const

describe('Notetaker speaker attribution', () => {
  it('credits Built-in speech-to-text segments to whoever the meeting app showed talking through them', async () => {
    const transport = speechProcess([
      { start: 0, end: 1.8, text: ' Morning, everyone.' },
      { start: 2.2, end: 4, text: ' Hi Alice.' },
    ])
    const settings = { speechToText: { kind: 'builtIn', modelId: 'apple' }, chat: CHAT_ENDPOINT, language: 'en' } satisfies ModelSettings
    const { controller, transcript, chunk } = notetaker(settings, { transport })

    controller.handleSpeakers({ timestamp: T0, platform: 'meet', speaking: ['Alice Smith'], selfSpeaking: false })
    controller.handleSpeakers({ timestamp: T0 + 2000, platform: 'meet', speaking: ['Bob Jones'], selfSpeaking: false })
    controller.handleChunk(chunk(0, 4000))

    await vi.waitFor(() => expect(transcript).toHaveLength(2))
    expect(transcript.map(({ text, startMs, endMs, speaker }) => ({ text, startMs, endMs, speaker }))).toEqual([
      { text: 'Morning, everyone.', startMs: 0, endMs: 1800, speaker: 'app:Alice Smith' },
      { text: 'Hi Alice.', startMs: 2200, endMs: 4000, speaker: 'app:Bob Jones' },
    ])
  })

  it('labels voices and sends them back as references with the diarizing Endpoint', async () => {
    const forms: FormData[] = []
    const replies = [
      { segments: [{ start: 0, end: 3, text: 'Shall we start?', speaker: 'A' }, { start: 3, end: 6, text: 'Yes, let us.', speaker: 'B' }] },
      { segments: [{ start: 0, end: 2, text: 'First item.', speaker: 'speaker_2' }] },
    ]
    const fetch = (async (_url: string, init?: RequestInit) => {
      forms.push(init?.body as FormData)
      return Response.json(replies[forms.length - 1])
    }) as typeof globalThis.fetch
    const diarizing = { kind: 'endpoint', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-transcribe-diarize', apiKey: 'k' } as const
    const { controller, transcript, chunk } = notetaker({ speechToText: diarizing, chat: CHAT_ENDPOINT, language: 'en' }, { fetch })

    controller.handleChunk(chunk(0, 6000))
    controller.handleChunk(chunk(6000, 2000))

    await vi.waitFor(() => expect(transcript).toHaveLength(3))
    expect(transcript.map((e) => e.speaker)).toEqual(['voice:1', 'voice:2', 'voice:2'])
    expect(forms[1]!.getAll('known_speaker_names[]')).toEqual(['speaker_1', 'speaker_2'])
    expect(forms[1]!.getAll('known_speaker_references[]')).toHaveLength(2)
  })
})
