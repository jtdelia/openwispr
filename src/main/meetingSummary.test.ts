import { describe, expect, it } from 'vitest'
import type { ModelSettings } from './models'
import { Models } from './models'
import type { ModelProcessMessage, ModelProcessTransport, ModelRequest } from './modelProcess'
import { summarizeMeeting, titleMeeting } from './meetingSummary'
import type { SummaryInput } from './meetingProcessing'

type CompleteRequest = Extract<ModelRequest, { type: 'complete' }>

/**
 * A model process whose chat model has `contextSize` tokens and counts `charsPerToken` characters as
 * one token. Like Apple's, it rejects a request that leaves fewer than 16 tokens for the answer, and
 * answers each completion with `answer`.
 */
function fakeChatProcess(contextSize: number, { charsPerToken = 4, answer = (n: number) => `S${n}` } = {}) {
  const completions: CompleteRequest[] = []
  const transport: ModelProcessTransport = {
    start(handlers) {
      const reply = (id: number, body: { result: unknown } | { error: { code: string; message: string } }) =>
        queueMicrotask(() => handlers.message({ type: 'response', id, ...body } as ModelProcessMessage))
      return {
        send(request) {
          switch (request.type) {
            case 'status':
              reply(request.id, {
                result: { appleSpeech: { available: true, locale: 'en-US', locales: ['en-US'] }, appleChat: { available: true, contextSize } },
              })
              return
            case 'complete': {
              completions.push(request)
              const chars = request.messages.reduce((sum, m) => sum + m.content.length, 0)
              const used = Math.ceil(chars / charsPerToken)
              if (contextSize - used < 16) {
                reply(request.id, { error: { code: 'contextExceeded', message: `Too long (${used} of ${contextSize} tokens)` } })
              } else {
                reply(request.id, { result: { text: answer(completions.length) } })
              }
              return
            }
            default:
              reply(request.id, { result: {} })
          }
        },
        stop() {
          queueMicrotask(() => handlers.exit(null))
        },
      }
    },
  }
  return { transport, completions }
}

const APPLE_CHAT = {
  speechToText: { kind: 'builtIn', modelId: 'apple' },
  chat: { kind: 'builtIn', modelId: 'apple' },
  language: 'en',
} satisfies ModelSettings

function appleModels(transport: ModelProcessTransport): Models {
  return new Models({ fetch: globalThis.fetch, settings: () => APPLE_CHAT, transport, modelsDir: '/nonexistent' })
}

/** One line per speaker turn, as `formatTranscript` writes them; each turn is about 50 tokens. */
function transcript(turns: number): string {
  return Array.from(
    { length: turns },
    (_, i) => `[${Math.floor(i / 2)}:${String((i % 2) * 30).padStart(2, '0')}] ${i % 2 ? 'Dana' : 'Me'}: Turn ${i} talks about the budget, the launch date and who sends the deck.`,
  ).join('\n')
}

const meeting = (lines: string, notes = 'ask about budget'): SummaryInput => ({
  title: 'Planning',
  transcript: lines,
  notes,
  userName: '',
  dictionary: [],
  recordedAt: Date.UTC(2026, 0, 5, 15),
})

const content = (request: CompleteRequest) => request.messages.map((m) => m.content).join('\n')

describe('summarizeMeeting', () => {
  it("summarizes a meeting longer than the chat model's context in pieces, then combines them with the user's notes", async () => {
    const process = fakeChatProcess(4096)
    const lines = transcript(400)

    const summary = await summarizeMeeting(appleModels(process.transport), meeting(lines))

    const { completions } = process
    expect(completions.length).toBeGreaterThan(2)
    const sections = completions.slice(0, -1)
    const final = completions.at(-1)!
    expect(summary).toBe(`S${completions.length}`)
    // Every turn is summarized exactly once, in order.
    const covered = sections.flatMap((s) => lines.split('\n').filter((line) => content(s).includes(line)))
    expect(covered).toEqual(lines.split('\n'))
    // The combining request sees every partial summary and the notes, but not the transcript.
    for (let n = 1; n < completions.length; n++) expect(content(final)).toContain(`S${n}`)
    expect(content(final)).toContain('ask about budget')
    expect(content(final)).not.toContain('Turn 0 ')
  })

  it('sends a meeting that fits the context in one request, however large the context is', async () => {
    const lines = transcript(400)
    const large = fakeChatProcess(32_768)
    expect(await summarizeMeeting(appleModels(large.transport), meeting(lines))).toBe('S1')
    expect(large.completions).toHaveLength(1)
    expect(content(large.completions[0]!)).toContain(lines)
    expect(content(large.completions[0]!)).toContain('ask about budget')

    const small = fakeChatProcess(4096)
    await summarizeMeeting(appleModels(small.transport), meeting(transcript(10)))
    expect(small.completions).toHaveLength(1)
  })

  it('splits a section further when the model counts more tokens than expected', async () => {
    const process = fakeChatProcess(4096, { charsPerToken: 2 })
    const lines = transcript(400)

    const summary = await summarizeMeeting(appleModels(process.transport), meeting(lines))

    const answered = process.completions.filter((_, i) => i < process.completions.length - 1)
    expect(summary).toBe(`S${process.completions.length}`)
    const covered = answered.flatMap((s) => lines.split('\n').filter((line) => content(s).includes(line)))
    // Rejected sections are sent again in halves, so turns repeat; each still appears in an answered request.
    expect(new Set(covered)).toEqual(new Set(lines.split('\n')))
  })

  it('merges partial summaries that are too long to combine at once, keeping the notes for the end', async () => {
    const long = (n: number) => `S${n} ${'decided something. '.repeat(80)}`
    const process = fakeChatProcess(4096, { answer: long })

    const summary = await summarizeMeeting(appleModels(process.transport), meeting(transcript(800)))

    const final = process.completions.at(-1)!
    expect(summary).toBe(long(process.completions.length).trim())
    expect(content(final)).toContain('ask about budget')
    expect(process.completions.slice(0, -1).some((r) => content(r).includes('ask about budget'))).toBe(false)
  })

  it('sends Endpoints the whole meeting in one request', async () => {
    const sent: Array<{ messages: Array<{ content: string }> }> = []
    const fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: '```markdown\n### Summary\nShipped.\n```' } }] })
    }) as typeof globalThis.fetch
    const settings = { ...APPLE_CHAT, chat: { kind: 'endpoint', baseUrl: 'https://chat.example/v1', model: 'gpt-x', apiKey: 'k' } } satisfies ModelSettings
    const endpoint = new Models({ fetch, settings: () => settings, transport: fakeChatProcess(4096).transport, modelsDir: '/nonexistent' })
    const lines = transcript(400)

    expect(await summarizeMeeting(endpoint, meeting(lines))).toBe('### Summary\nShipped.')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.messages.map((m) => m.content).join('\n')).toContain(lines)
  })
})

describe('titleMeeting', () => {
  it("names a long meeting from as much of its beginning as fits the chat model's context", async () => {
    const process = fakeChatProcess(4096, { answer: () => '"Launch Planning."' })
    const lines = transcript(400)

    expect(await titleMeeting(appleModels(process.transport), { transcript: lines, notes: 'ask about budget' })).toBe('Launch Planning')

    expect(process.completions).toHaveLength(1)
    const sent = content(process.completions[0]!)
    expect(sent).toContain(lines.split('\n').slice(0, 20).join('\n'))
    expect(sent).toContain('ask about budget')
  })
})
