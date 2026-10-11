import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../shared/types'
import type { ModelErrorCode, ModelProcessMessage, ModelProcessTransport, ModelRequest } from './modelProcess'
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

type Reply = { result: unknown } | { error: { code: ModelErrorCode; message: string } }

/**
 * A model process that answers each request with `respond`, or leaves it in flight when that returns
 * undefined. Every restart is a new connection.
 */
function fakeModelProcess(
  respond: (request: ModelRequest) => Reply | undefined = (request) => ({ result: request.type === 'transcribe' ? { text: 'hello' } : {} }),
) {
  const connections: Array<{ requests: ModelRequest[]; stopped: boolean; crash(): void; send(message: ModelProcessMessage): void }> = []
  const transport: ModelProcessTransport = {
    start(handlers) {
      const connection = {
        requests: [] as ModelRequest[],
        stopped: false,
        crash: () => handlers.exit('killed by signal SIGSEGV'),
        send: (message: ModelProcessMessage) => handlers.message(message),
      }
      connections.push(connection)
      return {
        send(request) {
          connection.requests.push(request)
          const reply = respond(request)
          if (reply) queueMicrotask(() => handlers.message({ type: 'response', id: request.id, ...reply } as ModelProcessMessage))
        },
        stop() {
          connection.stopped = true
          queueMicrotask(() => handlers.exit(null))
        },
      }
    },
  }
  return { transport, connections, requests: () => connections.flatMap((c) => c.requests) }
}

function models(
  settings: Partial<Settings> & ModelSettings,
  reply?: (url: string) => Response,
  transport: ModelProcessTransport = fakeModelProcess().transport,
) {
  const fake = fakeFetch(reply)
  return { models: new Models({ fetch: fake.fetch, settings: () => settings, transport, modelsDir: '/nonexistent' }), sent: fake.sent }
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

const APPLE_SPEECH = { ...ENDPOINTS, speechToText: { kind: 'builtIn', modelId: 'apple' }, language: 'en' } satisfies ModelSettings

describe('Models with Built-in speech-to-text', () => {
  it('sends transcription to the Apple model in the model process, with the audio in memory', async () => {
    const process = fakeModelProcess(() => ({ result: { text: ' Hello there. ' } }))
    const { models: m, sent } = models(APPLE_SPEECH, undefined, process.transport)
    expect(m.availability('speechToText')).toEqual({ available: true })
    expect(await m.transcribe(WAV, { prompt: 'Jane' })).toBe('Hello there.')
    expect(sent).toHaveLength(0)
    expect(process.requests()).toEqual([
      { id: expect.any(Number), type: 'transcribe', model: 'apple', audio: WAV.toString('base64'), language: 'en', prompt: 'Jane', segments: false },
    ])
  })

  it('returns timed segments clamped to the chunk for meetings', async () => {
    const process = fakeModelProcess(() => ({
      result: { text: 'Hi there', segments: [{ start: 0.5, end: 2, text: ' Hi' }, { start: 4, end: 9, text: ' there' }] },
    }))
    const { models: m } = models(APPLE_SPEECH, undefined, process.transport)
    expect(await m.transcribeSegments(WAV, { durationMs: 5000, prompt: '' })).toEqual([
      { startMs: 500, endMs: 2000, text: 'Hi', speaker: null },
      { startMs: 4000, endMs: 5000, text: 'there', speaker: null },
    ])
    expect(process.requests()[0]).toMatchObject({ type: 'transcribe', segments: true })
  })

  it('starts the model process and loads the model for the language when a dictation starts', async () => {
    const process = fakeModelProcess()
    const { models: m } = models(APPLE_SPEECH, undefined, process.transport)
    expect(process.connections).toHaveLength(0)
    m.warmUp()
    expect(process.requests()).toEqual([
      { id: expect.any(Number), type: 'load', models: [{ role: 'speechToText', id: 'apple', language: 'en' }] },
    ])
    await m.transcribe(WAV, { prompt: '' })
    expect(process.connections).toHaveLength(1)
  })

  it('stops the model process after 10 minutes without requests and restarts it for the next one', async () => {
    vi.useFakeTimers()
    try {
      const process = fakeModelProcess()
      const { models: m } = models(APPLE_SPEECH, undefined, process.transport)
      await m.transcribe(WAV, { prompt: '' })
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      await m.transcribe(WAV, { prompt: '' })
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      expect(process.connections[0].stopped).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(process.connections[0].stopped).toBe(true)

      expect(await m.transcribe(WAV, { prompt: '' })).toBe('hello')
      expect(process.connections).toHaveLength(2)
      expect(process.connections[1].requests).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the model process running while a request is in flight', async () => {
    vi.useFakeTimers()
    try {
      const process = fakeModelProcess(() => undefined)
      const { models: m } = models(APPLE_SPEECH, undefined, process.transport)
      void m.transcribe(WAV, { prompt: '' })
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(process.connections[0].stopped).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the in-flight request when the model process crashes, and restarts it for the next one', async () => {
    let answer = false
    const process = fakeModelProcess(() => (answer ? { result: { text: 'back again' } } : undefined))
    const { models: m } = models(APPLE_SPEECH, undefined, process.transport)
    const inFlight = m.transcribe(WAV, { prompt: '' })
    process.connections[0].crash()
    await expect(inFlight).rejects.toMatchObject({ code: 'modelFailed', message: expect.stringMatching(/stopped unexpectedly/) })

    answer = true
    expect(await m.transcribe(WAV, { prompt: '' })).toBe('back again')
    expect(process.connections).toHaveLength(2)
  })

  it('explains when Apple does not support the dictation language', async () => {
    const process = fakeModelProcess(() => ({
      error: { code: 'unsupportedLanguage', message: "Apple's speech-to-text doesn't support Dutch" },
    }))
    const { models: m } = models({ ...APPLE_SPEECH, language: 'nl' }, undefined, process.transport)
    await expect(m.transcribe(WAV, { prompt: '' })).rejects.toMatchObject({
      code: 'unsupportedLanguage',
      message: "Apple's speech-to-text doesn't support Dutch. Choose another language in Settings",
    })
    expect(process.requests()[0]).toMatchObject({ language: 'nl' })
  })

  it('reads the languages Apple supports from the model process', async () => {
    const status = { appleSpeech: { available: true, locale: null, locales: ['de-DE', 'en-US'] } }
    const process = fakeModelProcess(() => ({ result: status }))
    const { models: m } = models({ ...APPLE_SPEECH, language: 'nl' }, undefined, process.transport)
    expect(await m.status()).toEqual(status)
    expect(process.requests()).toEqual([{ id: expect.any(Number), type: 'status', language: 'nl' }])
  })

  it('reports Apple language-asset download progress while warming up', () => {
    const process = fakeModelProcess(() => undefined)
    const { models: m } = models(APPLE_SPEECH, undefined, process.transport)
    const progress: unknown[] = []
    m.on('progress', (p) => progress.push(p))
    m.warmUp()
    process.connections[0].send({ type: 'progress', kind: 'appleSpeechAssets', locale: 'fr-FR', fraction: 0.25 })
    expect(progress).toEqual([{ kind: 'appleSpeechAssets', locale: 'fr-FR', fraction: 0.25 }])
  })

  it('does not start the model process to warm up an Endpoint', () => {
    const process = fakeModelProcess()
    models(ENDPOINTS, undefined, process.transport).models.warmUp()
    expect(process.connections).toHaveLength(0)
  })
})

const PARAKEET = { ...ENDPOINTS, speechToText: { kind: 'builtIn', modelId: 'parakeet-tdt-0.6b-v3' }, language: 'de' } satisfies ModelSettings

describe('Models with a downloaded Parakeet model', () => {
  it('sends dictations to the Parakeet model in the model process', async () => {
    const process = fakeModelProcess(() => ({ result: { text: ' Guten Morgen. ' } }))
    const { models: m, sent } = models(PARAKEET, undefined, process.transport)
    expect(m.availability('speechToText')).toEqual({ available: true })
    m.warmUp()
    expect(await m.transcribe(WAV, { prompt: 'Jane' })).toBe('Guten Morgen.')
    expect(sent).toHaveLength(0)
    expect(process.requests()).toEqual([
      { id: expect.any(Number), type: 'load', models: [{ role: 'speechToText', id: 'parakeet-tdt-0.6b-v3', language: 'de' }] },
      {
        id: expect.any(Number),
        type: 'transcribe',
        model: 'parakeet-tdt-0.6b-v3',
        audio: WAV.toString('base64'),
        language: 'de',
        prompt: 'Jane',
        segments: false,
      },
    ])
  })

  it('returns timed segments for meetings', async () => {
    const process = fakeModelProcess(() => ({
      result: { text: 'Hallo. Wie geht es?', segments: [{ start: 0.2, end: 1.1, text: 'Hallo.' }, { start: 1.6, end: 2.8, text: 'Wie geht es?' }] },
    }))
    const { models: m } = models(PARAKEET, undefined, process.transport)
    expect(await m.transcribeSegments(WAV, { durationMs: 5000, prompt: '' })).toEqual([
      { startMs: 200, endMs: 1100, text: 'Hallo.', speaker: null },
      { startMs: 1600, endMs: 2800, text: 'Wie geht es?', speaker: null },
    ])
    expect(process.requests()[0]).toMatchObject({ type: 'transcribe', model: 'parakeet-tdt-0.6b-v3', segments: true })
  })

  it('asks the model process which languages the selected Parakeet model supports', async () => {
    const status = {
      appleSpeech: { available: true, locale: 'ja-JP', locales: ['ja-JP'] },
      speechToText: { model: 'parakeet-tdt-0.6b-v3', name: 'Parakeet TDT v3', supported: false, languages: ['de', 'en'] },
    }
    const process = fakeModelProcess(() => ({ result: status }))
    const { models: m } = models({ ...PARAKEET, language: 'ja' }, undefined, process.transport)
    expect(await m.status()).toEqual(status)
    expect(process.requests()).toEqual([{ id: expect.any(Number), type: 'status', language: 'ja', speechToText: 'parakeet-tdt-0.6b-v3' }])
  })

  it('explains when Parakeet does not support the dictation language', async () => {
    const process = fakeModelProcess(() => ({
      error: { code: 'unsupportedLanguage', message: "Parakeet TDT v3 doesn't support Japanese" },
    }))
    const { models: m } = models({ ...PARAKEET, language: 'ja' }, undefined, process.transport)
    await expect(m.transcribe(WAV, { prompt: '' })).rejects.toMatchObject({
      code: 'unsupportedLanguage',
      message: "Parakeet TDT v3 doesn't support Japanese. Choose another language in Settings",
    })
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

  it('reports Built-in chat and downloaded speech-to-text models as unavailable until they ship', async () => {
    const process = fakeModelProcess()
    const { models: m, sent } = models(
      { ...ENDPOINTS, speechToText: { kind: 'builtIn', modelId: 'whisper-small' }, chat: { kind: 'builtIn', modelId: 'apple' } },
      undefined,
      process.transport,
    )
    expect(m.availability('chat')).toEqual({ available: false, reason: 'Built-in models are not available yet' })
    expect(m.availability('speechToText')).toEqual({ available: false, reason: 'Built-in models are not available yet' })
    await expect(m.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('Built-in models are not available yet')
    await expect(m.transcribe(WAV, { prompt: '' })).rejects.toThrow('Built-in models are not available yet')
    expect(sent).toHaveLength(0)
    expect(process.requests()).toHaveLength(0)
  })
})
