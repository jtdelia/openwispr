import { describe, expect, it } from 'vitest'
import type { Settings } from '../shared/types'
import { Models, type ModelSettings } from './models'
import { loadSettings } from './settings'

interface SentRequest {
  url: string
  headers: Record<string, string>
  form: FormData | null
  json: { model?: string; messages?: unknown } | null
}

/** A `fetch` that answers every request with `reply` and records what was sent. */
function fakeFetch(reply: (url: string) => Response = () => Response.json({ text: 'hello' })) {
  const sent: SentRequest[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const body = init?.body
    sent.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      form: body instanceof FormData ? body : null,
      json: typeof body === 'string' ? JSON.parse(body) : null,
    })
    return reply(url)
  }
  return { fetch: fetch as typeof globalThis.fetch, sent }
}

const WAV = Buffer.alloc(44 + 16000)

const ENDPOINTS = {
  speechToText: { kind: 'endpoint', baseUrl: 'https://stt.example/v1/', model: 'whisper-1', apiKey: 'stt-key' },
  chat: { kind: 'endpoint', baseUrl: 'https://chat.example/v1', model: 'gpt-x', apiKey: 'chat-key' },
  language: 'de',
} satisfies ModelSettings

function models(settings: Partial<Settings> & ModelSettings, reply?: (url: string) => Response) {
  const fake = fakeFetch(reply)
  return { models: new Models({ fetch: fake.fetch, settings: () => settings, modelsDir: '/nonexistent' }), sent: fake.sent }
}

describe('Models routing', () => {
  it('sends transcription to the speech-to-text Endpoint with its model, key and language', async () => {
    const { models: m, sent } = models(ENDPOINTS)
    expect(await m.transcribe(WAV, { prompt: 'Jane' })).toBe('hello')
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://stt.example/v1/audio/transcriptions')
    expect(sent[0].headers.Authorization).toBe('Bearer stt-key')
    expect(sent[0].form?.get('model')).toBe('whisper-1')
    expect(sent[0].form?.get('language')).toBe('de')
    expect(sent[0].form?.get('prompt')).toBe('Jane')
  })

  it('sends chat completions to the chat Endpoint', async () => {
    const { models: m, sent } = models(ENDPOINTS, () =>
      Response.json({ choices: [{ message: { content: 'Tidy text.' } }] }),
    )
    const messages = [{ role: 'user' as const, content: 'tidy text' }]
    expect(await m.complete(messages)).toBe('Tidy text.')
    expect(sent[0].url).toBe('https://chat.example/v1/chat/completions')
    expect(sent[0].headers.Authorization).toBe('Bearer chat-key')
    expect(sent[0].json).toEqual({ model: 'gpt-x', messages })
  })

  it('lets a chat Endpoint without a key use the speech-to-text key for the same server', async () => {
    const shared = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', apiKey: '' }
    const { models: m, sent } = models(
      { ...ENDPOINTS, speechToText: { ...ENDPOINTS.speechToText, baseUrl: shared.baseUrl }, chat: { kind: 'endpoint', ...shared } },
      () => Response.json({ choices: [{ message: { content: 'ok' } }] }),
    )
    await m.complete([{ role: 'user', content: 'hi' }])
    expect(sent[0].headers.Authorization).toBe('Bearer stt-key')
  })
})

describe('Models segments for meetings', () => {
  const withModel = (model: string, reply: () => Response) =>
    models({ ...ENDPOINTS, speechToText: { ...ENDPOINTS.speechToText, model } }, reply)

  it('asks Whisper models for timed segments and clamps them to the chunk', async () => {
    const { models: m, sent } = withModel('whisper-large-v3-turbo', () =>
      Response.json({ segments: [{ start: 0.5, end: 2, text: ' Hi ' }, { start: 4, end: 9, text: 'there' }, { text: ' ' }] }),
    )
    expect(await m.transcribeSegments(WAV, { durationMs: 5000, prompt: 'Jane' })).toEqual([
      { startMs: 500, endMs: 2000, text: 'Hi', speaker: null },
      { startMs: 4000, endMs: 5000, text: 'there', speaker: null },
    ])
    expect(sent[0].form?.get('response_format')).toBe('verbose_json')
    expect(sent[0].form?.get('timestamp_granularities[]')).toBe('segment')
    expect(sent[0].form?.get('prompt')).toBe('Jane')
  })

  it('sends known voices to diarizing models and keeps their speaker labels', async () => {
    const { models: m, sent } = withModel('gpt-4o-transcribe-diarize', () =>
      Response.json({ segments: [{ start: 0, end: 1, text: 'Hello', speaker: 'voice-1' }] }),
    )
    const known = { names: ['voice-1'], references: ['data:audio/wav;base64,AAAA'] }
    expect(await m.transcribeSegments(WAV, { durationMs: 3000, prompt: 'Jane', known })).toEqual([
      { startMs: 0, endMs: 1000, text: 'Hello', speaker: 'voice-1' },
    ])
    expect(sent[0].form?.get('response_format')).toBe('diarized_json')
    expect(sent[0].form?.getAll('known_speaker_names[]')).toEqual(['voice-1'])
    expect(sent[0].form?.getAll('known_speaker_references[]')).toEqual(['data:audio/wav;base64,AAAA'])
    expect(sent[0].form?.get('prompt')).toBeNull()
  })

  it('treats untimed text as one segment covering the chunk, and no text as none', async () => {
    const plain = withModel('gpt-4o-mini-transcribe', () => Response.json({ text: ' Hello there ' }))
    expect(await plain.models.transcribeSegments(WAV, { durationMs: 5000, prompt: '' })).toEqual([
      { startMs: 0, endMs: 5000, text: 'Hello there', speaker: null },
    ])
    expect(plain.sent[0].form?.get('response_format')).toBe('json')
    const silent = withModel('gpt-4o-mini-transcribe', () => Response.json({ text: '' }))
    expect(await silent.models.transcribeSegments(WAV, { durationMs: 5000, prompt: '' })).toEqual([])
  })
})

describe('Models Endpoint test', () => {
  it('reports success when each Endpoint answers', async () => {
    const { models: m, sent } = models(ENDPOINTS, (url) =>
      url.endsWith('/chat/completions') ? Response.json({ choices: [{ message: { content: 'OK' } }] }) : Response.json({ text: '' }),
    )
    expect(await m.testEndpoint('speechToText')).toEqual({ ok: true })
    expect(await m.testEndpoint('chat')).toEqual({ ok: true })
    expect(sent.map((r) => r.url)).toEqual([
      'https://stt.example/v1/audio/transcriptions',
      'https://chat.example/v1/chat/completions',
    ])
    expect(sent[0].headers.Authorization).toBe('Bearer stt-key')
    expect(sent[1].json?.model).toBe('gpt-x')
  })

  it("reports the server's error", async () => {
    const { models: m } = models(ENDPOINTS, () =>
      Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 }),
    )
    expect(await m.testEndpoint('chat')).toEqual({ ok: false, error: 'Chat failed (401): Incorrect API key provided' })
    expect(await m.testEndpoint('speechToText')).toEqual({
      ok: false,
      error: 'Transcription failed (401): Incorrect API key provided',
    })
  })

  it('reports an unreachable server', async () => {
    const { models: m } = models(ENDPOINTS, () => {
      throw new TypeError('fetch failed')
    })
    expect(await m.testEndpoint('chat')).toEqual({ ok: false, error: 'fetch failed' })
  })
})

describe('settings migration', () => {
  const groqFile = {
    transcription: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', apiKey: 'enc:groq', language: 'fr' },
    cleanup: { enabled: false, baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: '' },
    sounds: false,
    userName: 'Jane',
  }

  it('turns the old provider settings into Endpoint selections with the same values', () => {
    const settings = loadSettings(groqFile)
    expect(settings.speechToText).toEqual({
      kind: 'endpoint',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
      apiKey: 'enc:groq',
    })
    expect(settings.chat).toEqual({
      kind: 'endpoint',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      apiKey: '',
    })
    expect(settings.language).toBe('fr')
    expect(settings.cleanup).toEqual({ enabled: false })
    expect(settings.sounds).toBe(false)
    expect(settings.userName).toBe('Jane')
    expect(settings).not.toHaveProperty('transcription')
  })

  it('keeps routing to the same servers with the same keys after migrating', async () => {
    const settings = loadSettings({ ...groqFile, transcription: { ...groqFile.transcription, apiKey: 'gsk-plain' } })
    const { models: m, sent } = models(settings, (url) =>
      url.endsWith('/chat/completions') ? Response.json({ choices: [{ message: { content: 'ok' } }] }) : Response.json({ text: 'salut' }),
    )
    expect(await m.transcribe(WAV, { prompt: '' })).toBe('salut')
    await m.complete([{ role: 'user', content: 'hi' }])
    expect(sent.map((r) => [r.url, r.headers.Authorization])).toEqual([
      ['https://api.groq.com/openai/v1/audio/transcriptions', 'Bearer gsk-plain'],
      ['https://api.groq.com/openai/v1/chat/completions', 'Bearer gsk-plain'],
    ])
    expect(sent[0].form?.get('language')).toBe('fr')
  })

  it('fills in defaults for a fresh install and leaves already-migrated settings alone', () => {
    const fresh = loadSettings({})
    expect(fresh.speechToText).toEqual({ kind: 'endpoint', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', apiKey: '' })
    expect(fresh.chat).toEqual({ kind: 'endpoint', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: '' })
    expect(fresh.cleanup).toEqual({ enabled: true })
    expect(loadSettings(JSON.parse(JSON.stringify(loadSettings(groqFile))))).toEqual(loadSettings(groqFile))
  })
})

describe('Models availability', () => {
  const keyless = { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', apiKey: '' }

  it('makes a keyless chat Endpoint available, so Cleanup runs against local servers', async () => {
    const { models: m, sent } = models({ ...ENDPOINTS, chat: { kind: 'endpoint', ...keyless } }, () =>
      Response.json({ choices: [{ message: { content: 'ok' } }] }),
    )
    expect(m.availability('chat')).toEqual({ available: true })
    await m.complete([{ role: 'user', content: 'hi' }])
    expect(sent[0].url).toBe('http://localhost:11434/v1/chat/completions')
    expect(sent[0].headers.Authorization).toBeUndefined()
  })

  it('needs a chat model name', () => {
    const { models: m } = models({ ...ENDPOINTS, chat: { kind: 'endpoint', ...keyless, model: ' ' } })
    expect(m.availability('chat')).toEqual({ available: false, reason: 'Set up a chat model in Settings' })
  })

  it('asks for a key before transcribing with a cloud Endpoint, but not a local one', () => {
    const cloud = models({ ...ENDPOINTS, speechToText: { ...ENDPOINTS.speechToText, apiKey: '' } }).models
    expect(cloud.availability('speechToText')).toEqual({
      available: false,
      reason: 'Add a transcription API key in Settings',
    })
    const local = models({ ...ENDPOINTS, speechToText: { kind: 'endpoint', ...keyless } }).models
    expect(local.availability('speechToText')).toEqual({ available: true })
  })

  it('reports Built-in models as unavailable until they ship', async () => {
    const { models: m, sent } = models({ ...ENDPOINTS, speechToText: { kind: 'builtIn', modelId: 'apple' } })
    expect(m.availability('speechToText')).toEqual({ available: false, reason: 'Built-in models are not available yet' })
    await expect(m.transcribe(WAV, { prompt: '' })).rejects.toThrow('Built-in models are not available yet')
    expect(sent).toHaveLength(0)
  })
})
