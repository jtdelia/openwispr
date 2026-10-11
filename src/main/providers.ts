import type { EndpointConfig } from '../shared/types'

const TIMEOUT_MS = 60_000

export type Fetch = typeof globalThis.fetch

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function authHeaders(config: EndpointConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

async function failure(response: Response, what: string): Promise<Error> {
  const body = await response.text().catch(() => '')
  let detail = body.slice(0, 300)
  try {
    detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail
  } catch {
    // Non-JSON error body; keep the raw text.
  }
  return new Error(`${what} failed (${response.status}): ${detail}`)
}

/** OpenAI-compatible `/audio/transcriptions` (OpenAI, Groq, whisper.cpp server, LocalAI, …). */
export async function transcribe(
  fetch: Fetch,
  config: EndpointConfig & { language: string },
  wav: Buffer,
  prompt: string,
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dictation.wav')
  form.append('model', config.model)
  form.append('response_format', 'json')
  if (config.language) form.append('language', config.language)
  if (prompt) form.append('prompt', prompt)

  const response = await fetch(endpoint(config.baseUrl, '/audio/transcriptions'), {
    method: 'POST',
    headers: authHeaders(config),
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw await failure(response, 'Transcription')
  const json = (await response.json()) as { text?: string }
  return (json.text ?? '').trim()
}

export interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
  /** The diarization label, when the model tells voices apart. */
  speaker: string | null
}

export interface KnownSpeakers {
  names: string[]
  /** `data:audio/wav;base64,…` clips, one per name. */
  references: string[]
}

type SegmentFormat = 'diarized_json' | 'verbose_json' | 'json'

/** Diarizing models label voices; Whisper models time their segments; others return plain text. */
function segmentFormat(model: string): SegmentFormat {
  if (/diariz/i.test(model)) return 'diarized_json'
  if (/whisper/i.test(model)) return 'verbose_json'
  return 'json'
}

interface TranscriptionResponse {
  text?: string
  segments?: Array<{ start?: number; end?: number; text?: string; speaker?: string }>
}

export function parseSegments(json: TranscriptionResponse, durationMs: number): TranscriptSegment[] {
  const clamp = (seconds: number | undefined) => Math.min(durationMs, Math.max(0, Math.round((seconds ?? 0) * 1000)))
  const segments = (json.segments ?? [])
    .map((s) => ({
      startMs: clamp(s.start),
      endMs: clamp(s.end),
      text: (s.text ?? '').trim(),
      speaker: s.speaker ?? null,
    }))
    .filter((s) => s.text)
  if (segments.length > 0) return segments
  const text = (json.text ?? '').trim()
  return text ? [{ startMs: 0, endMs: durationMs, text, speaker: null }] : []
}

/** Like `transcribe`, but keeps the timing and, for diarizing models, the voice of each segment. */
export async function transcribeSegments(
  fetch: Fetch,
  config: EndpointConfig & { language: string },
  wav: Buffer,
  durationMs: number,
  prompt: string,
  known?: KnownSpeakers,
): Promise<TranscriptSegment[]> {
  const format = segmentFormat(config.model)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'meeting.wav')
  form.append('model', config.model)
  form.append('response_format', format)
  if (config.language) form.append('language', config.language)
  switch (format) {
    case 'diarized_json':
      form.append('chunking_strategy', 'auto')
      for (const name of known?.names ?? []) form.append('known_speaker_names[]', name)
      for (const reference of known?.references ?? []) form.append('known_speaker_references[]', reference)
      break
    case 'verbose_json':
      form.append('timestamp_granularities[]', 'segment')
      if (prompt) form.append('prompt', prompt)
      break
    case 'json':
      if (prompt) form.append('prompt', prompt)
      break
    default: {
      const unreachable: never = format
      throw new Error(`unhandled segment format ${String(unreachable)}`)
    }
  }

  const response = await fetch(endpoint(config.baseUrl, '/audio/transcriptions'), {
    method: 'POST',
    headers: authHeaders(config),
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw await failure(response, 'Transcription')
  return parseSegments((await response.json()) as TranscriptionResponse, durationMs)
}

export type ChatMessage = { role: 'system' | 'user'; content: string }

/** OpenAI-compatible `/chat/completions`. */
export async function complete(
  fetch: Fetch,
  config: EndpointConfig,
  messages: ChatMessage[],
  { label = 'Cleanup', timeoutMs = TIMEOUT_MS }: { label?: string; timeoutMs?: number } = {},
): Promise<string> {
  const response = await fetch(endpoint(config.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, messages }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw await failure(response, label)
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return json.choices?.[0]?.message?.content ?? ''
}
