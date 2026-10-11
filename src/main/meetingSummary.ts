import {
  mergeMessages,
  sanitizeSummary,
  sanitizeTitle,
  sectionMessages,
  shortenTranscript,
  summaryMessages,
  titleMessages,
  type SummaryInput,
} from './meetingProcessing'
import { ModelError } from './modelProcess'
import type { ChatMessage, Models } from './models'

export type MeetingChat = Pick<Models, 'complete' | 'chatContextSize'>

/** Lower than real tokenizers give for most languages, so a request estimated to fit usually does. */
const CHARS_PER_TOKEN = 3
/** A section the model still finds too long is split further, down to this size. */
const MIN_SECTION_CHARS = 200
const TITLE_TOKENS = 64
const TITLE_TRANSCRIPT_CHARS = 12_000

function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / CHARS_PER_TOKEN)
}

function isTooLong(error: unknown): boolean {
  return error instanceof ModelError && error.code === 'contextExceeded'
}

/** Splits `text` into pieces of at most `max` characters, at whitespace where there is some. */
function splitText(text: string, max: number): string[] {
  const pieces: string[] = []
  let rest = text
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max)
    const at = space > max / 2 ? space : max
    pieces.push(rest.slice(0, at))
    rest = rest.slice(at).trimStart()
  }
  if (rest) pieces.push(rest)
  return pieces
}

/** Packs whole lines into sections of at most `max` characters; longer lines are split. */
function sections(text: string, max: number): string[] {
  const result: string[] = []
  let current = ''
  for (const line of text.split('\n').flatMap((l) => splitText(l, max))) {
    if (current && current.length + 1 + line.length > max) {
      result.push(current)
      current = ''
    }
    current = current ? `${current}\n${line}` : line
  }
  if (current) result.push(current)
  return result
}

function halve(section: string): [string, string] {
  const lines = section.split('\n')
  if (lines.length > 1) {
    const middle = Math.ceil(lines.length / 2)
    return [lines.slice(0, middle).join('\n'), lines.slice(middle).join('\n')]
  }
  const [first, ...rest] = splitText(section, Math.ceil(section.length / 2))
  return [first ?? '', rest.join(' ')]
}

/**
 * The meeting notes for `input`. When the transcript and notes don't fit the chat model's context,
 * consecutive sections of the transcript are summarized first, and those summaries are combined with
 * the user's notes. Endpoints report no context size and get the whole meeting in one request.
 */
export async function summarizeMeeting(
  chat: MeetingChat,
  input: SummaryInput,
  { timeoutMs }: { timeoutMs?: number } = {},
): Promise<string> {
  const contextSize = await chat.chatContextSize()
  if (contextSize === null) {
    const messages = summaryMessages({ ...input, transcript: shortenTranscript(input.transcript) })
    return sanitizeSummary(await chat.complete(messages, { label: 'Summary', timeoutMs }))
  }
  return sanitizeSummary(await new PiecewiseSummary(chat, input, contextSize).run())
}

/**
 * A title for the meeting, from the start of its transcript (where meetings say what they're about)
 * and the notes, cut to fit the chat model's context.
 */
export async function titleMeeting(chat: MeetingChat, input: { transcript: string; notes: string }): Promise<string> {
  const contextSize = await chat.chatContextSize()
  let { transcript, notes } = input
  if (contextSize === null) {
    transcript = transcript.slice(0, TITLE_TRANSCRIPT_CHARS)
  } else {
    notes = notes.trim().slice(0, (contextSize / 4) * CHARS_PER_TOKEN)
    const overhead = estimateTokens(titleMessages({ transcript: '', notes }))
    transcript = transcript.slice(0, Math.max(0, (contextSize - overhead - TITLE_TOKENS) * CHARS_PER_TOKEN))
  }
  return sanitizeTitle(await chat.complete(titleMessages({ transcript, notes }), { label: 'Title', maxTokens: TITLE_TOKENS }))
}

class PiecewiseSummary {
  private readonly answerTokens: number
  private readonly partTokens: number
  /** The user's notes steer the combined summary, so they keep up to a quarter of the context. */
  private readonly combineInput: SummaryInput

  constructor(
    private readonly chat: MeetingChat,
    private readonly input: SummaryInput,
    private readonly contextSize: number,
  ) {
    this.answerTokens = Math.min(2048, Math.floor(contextSize / 4))
    this.partTokens = Math.min(512, Math.floor(contextSize / 8))
    this.combineInput = { ...input, notes: input.notes.trim().slice(0, (contextSize / 4) * CHARS_PER_TOKEN) }
  }

  async run(): Promise<string> {
    const whole = summaryMessages(this.input)
    if (this.fits(whole, this.answerTokens)) {
      try {
        return await this.complete(whole, this.answerTokens)
      } catch (error) {
        if (!isTooLong(error)) throw error
      }
    }
    const parts: string[] = []
    for (const section of sections(this.input.transcript, this.budgetChars(sectionMessages(this.input, '')))) {
      parts.push(...(await this.summarizeSection(section)))
    }
    return this.combine(parts)
  }

  private async summarizeSection(section: string): Promise<string[]> {
    try {
      return [await this.complete(sectionMessages(this.input, section), this.partTokens)]
    } catch (error) {
      if (!isTooLong(error) || section.length < MIN_SECTION_CHARS * 2) throw error
      const [first, second] = halve(section)
      return [...(await this.summarizeSection(first)), ...(await this.summarizeSection(second))]
    }
  }

  private async combine(parts: string[]): Promise<string> {
    let current = parts
    for (;;) {
      const messages = summaryMessages(this.combineInput, current)
      if (current.length > 1 && !this.fits(messages, this.answerTokens)) {
        current = await this.merge(current)
        continue
      }
      try {
        return await this.complete(messages, this.answerTokens)
      } catch (error) {
        if (!isTooLong(error) || current.length === 1) throw error
        current = await this.merge(current)
      }
    }
  }

  /** Merges consecutive parts in groups of at least two, so each round leaves fewer. */
  private async merge(parts: string[]): Promise<string[]> {
    const max = this.budgetChars(mergeMessages(this.input, []))
    const groups: string[][] = []
    let group: string[] = []
    let size = 0
    for (const part of parts) {
      if (group.length >= 2 && size + part.length > max) {
        groups.push(group)
        group = []
        size = 0
      }
      group.push(part)
      size += part.length
    }
    if (group.length === 1 && groups.length > 0) groups.at(-1)!.push(...group)
    else groups.push(group)
    const merged: string[] = []
    for (const g of groups) merged.push(await this.complete(mergeMessages(this.input, g), this.partTokens))
    return merged
  }

  /** Characters of transcript or notes that fit next to `overhead` and a part's answer. */
  private budgetChars(overhead: ChatMessage[]): number {
    return Math.max(MIN_SECTION_CHARS, (this.contextSize - estimateTokens(overhead) - this.partTokens) * CHARS_PER_TOKEN)
  }

  private fits(messages: ChatMessage[], answerTokens: number): boolean {
    return estimateTokens(messages) + answerTokens <= this.contextSize
  }

  private complete(messages: ChatMessage[], maxTokens: number): Promise<string> {
    return this.chat.complete(messages, { label: 'Summary', maxTokens })
  }
}
