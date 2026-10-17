import { formatClock } from '../shared/time'
import { defaultSpeakerLabel, speakerLabel, transcriptTurns, YOU } from '../shared/speakers'
import type { DictionaryEntry, TranscriptEntry } from '../shared/types'

type ChatMessage = { role: 'system' | 'user'; content: string }

/** Roughly 50k tokens; longer transcripts keep their beginning and end, which carry intros and wrap-ups. */
const MAX_TRANSCRIPT_CHARS = 200_000
const TITLE_MAX_CHARS = 80

/**
 * Whisper-family models invent these on near-silent audio (trained on subtitled video). A chunk whose
 * entire text is one of them is dropped. Plausible meeting phrases like "Thank you" are not listed.
 */
const HALLUCINATIONS = new Set(
  [
    'you',
    'thanks for watching',
    'thank you for watching',
    'thank you so much for watching',
    'please subscribe',
    'like and subscribe',
    'subtitles by the amaraorg community',
  ].map(normalizeForComparison),
)

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isLikelyHallucination(text: string): boolean {
  const normalized = normalizeForComparison(text)
  return normalized === '' || HALLUCINATIONS.has(normalized)
}

/** One line per speaker turn, labelled with the names the user gave or the detected ones. */
export function formatTranscript(entries: TranscriptEntry[], names: Record<string, string>, userName: string): string {
  return transcriptTurns(entries)
    .map((t) => `[${formatClock(t.startMs)}] ${speakerLabel(t.speaker, names, userName)}: ${t.text.trim()}`)
    .join('\n')
}

/** For chat models of unknown context, which get the whole meeting in one request. */
export function shortenTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text
  const half = MAX_TRANSCRIPT_CHARS / 2
  return `${text.slice(0, half)}\n[… middle of the meeting omitted for length …]\n${text.slice(-half)}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Rewrites speaker labels in an existing summary after the user renames speakers, e.g. "Speaker 2" → "Dana". */
export function relabelSummary(summary: string, renames: Array<{ from: string; to: string }>): string {
  const changed = renames
    .filter((r) => r.from && r.to && r.from !== r.to)
    .sort((a, b) => b.from.length - a.from.length)
  if (changed.length === 0) return summary
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${changed.map((r) => escapeRegExp(r.from)).join('|')})(?![\\p{L}\\p{N}])`, 'gu')
  const to = new Map(changed.map((r) => [r.from, r.to]))
  return summary.replace(pattern, (match) => to.get(match) ?? match)
}

/** Whisper's prompt conditions spelling and continuity; the previous text of the same speaker helps both. */
export function chunkPrompt(vocabularyPrompt: string, previousText: string): string {
  const tail = previousText.slice(-400).trim()
  return [vocabularyPrompt, tail].filter(Boolean).join(' ')
}

export function titleMessages(input: { transcript: string; notes: string }): ChatMessage[] {
  const system = [
    'You name meetings. Read the meeting transcript and the attendee notes and reply with a concise 3-6 word title for the meeting.',
    'The transcript is the primary grounding; the notes are secondary context. Do not copy a sentence verbatim.',
    'Output only the title: no quotes, no trailing punctuation, no prefix such as "Title:".',
  ].join('\n')
  const user = [
    input.transcript && `<transcript>\n${input.transcript}\n</transcript>`,
    input.notes.trim() && `<notes>\n${input.notes.trim()}\n</notes>`,
  ]
    .filter(Boolean)
    .join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function sanitizeTitle(output: string): string {
  const firstLine = output.trim().split('\n')[0] ?? ''
  const title = firstLine
    .replace(/^(title|meeting title)\s*:\s*/i, '')
    .replace(/^["'“‘*#\s]+|["'”’*\s]+$/g, '')
    .replace(/[.!?;:,]+$/, '')
    .trim()
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : title
}

export interface SummaryInput {
  title: string
  transcript: string
  notes: string
  userName: string
  dictionary: DictionaryEntry[]
  recordedAt: number
}

function spellingRule(dictionary: DictionaryEntry[]): string[] {
  const spellings = dictionary.map((d) => d.word.trim()).filter(Boolean)
  return spellings.length > 0 ? [`- Always use these exact spellings: ${spellings.join(', ')}.`] : []
}

function formatParts(parts: string[]): string {
  return `<parts>\n${parts.map((p, i) => `Part ${i + 1}:\n${p.trim()}`).join('\n\n')}\n</parts>`
}

/**
 * The meeting notes, from the transcript or, for a meeting too long for the chat model, from `parts`:
 * summaries of its consecutive sections, in order.
 */
export function summaryMessages(input: SummaryInput, parts?: string[]): ChatMessage[] {
  const me = defaultSpeakerLabel(YOU, input.userName)
  const rules = [
    parts
      ? "You are a meeting notetaker. You receive notes on consecutive parts of a long meeting's transcript, in order, and the user's own notes, and write the meeting notes in Markdown."
      : "You are a meeting notetaker. You receive a meeting transcript and the user's own notes, and write the meeting notes in Markdown.",
    '',
    'The transcript comes from two audio channels:',
    `- "${me}" is the user, recorded from their microphone.`,
    '- Everyone else on the call is recorded from the computer audio. A name means the meeting app showed that person talking, or the user named them. "Speaker 1", "Speaker 2", … are distinct voices whose names are unknown. "Others" is call audio that could not be attributed and may mix several people: tell them apart by context and use names when they are mentioned.',
    'The transcript is automatic speech recognition: expect misheard words and fix them when the context makes the intent clear.',
    '',
    'Write these sections, in this order, as `###` headings. Omit any section that would be empty:',
    '### Summary: two to four sentences on the purpose and outcome of the meeting.',
    '### Key points: bullets grouped by topic, using bold topic labels when there are several topics.',
    '### Decisions: bullets for what was agreed.',
    '### Action Items: one `- [ ]` checkbox per task, starting with the owner when known (e.g. `- [ ] **Sam**: send the deck`).',
    '',
    'Rules:',
    '- Output only the Markdown notes: no preamble and no closing remarks.',
    "- The user's notes show what mattered to them: make sure those topics are covered, but do not repeat the notes verbatim.",
    '- Be specific: keep names, numbers, dates and commitments. Leave out small talk and filler.',
    '- Never invent facts that are not supported by the transcript or notes.',
    '- Write in the language the meeting was held in.',
    ...spellingRule(input.dictionary),
  ]

  const user = [
    '<meeting>',
    `Title: ${input.title.trim() || '(untitled)'}`,
    `Date: ${new Date(input.recordedAt).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}`,
    '</meeting>',
    `<notes>\n${input.notes.trim() || '(none)'}\n</notes>`,
    parts ? formatParts(parts) : `<transcript>\n${input.transcript}\n</transcript>`,
  ].join('\n')

  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: user },
  ]
}

/** Notes on one section of a meeting too long for the chat model, to be combined by `summaryMessages`. */
export function sectionMessages(
  input: Pick<SummaryInput, 'userName' | 'dictionary'>,
  section: string,
): ChatMessage[] {
  const me = defaultSpeakerLabel(YOU, input.userName)
  const rules = [
    'You take notes on one part of a long meeting, to be combined into the meeting notes later.',
    `"${me}" is the user. Other names are call participants, "Speaker 1", "Speaker 2", … are voices whose names are unknown, and "Others" is call audio that could not be attributed.`,
    'The transcript is automatic speech recognition: fix misheard words when the context makes the intent clear.',
    '',
    'Rules:',
    '- Write short Markdown bullets: the topics discussed, what was decided, and every task with its owner.',
    '- Keep names, numbers, dates and commitments. Leave out small talk and filler.',
    '- Output only the bullets. Never invent facts.',
    '- Write in the language the meeting was held in.',
    ...spellingRule(input.dictionary),
  ]
  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: `<transcript>\n${section}\n</transcript>` },
  ]
}

/** Merges notes on consecutive sections when there are too many to combine at once. */
export function mergeMessages(input: Pick<SummaryInput, 'dictionary'>, parts: string[]): ChatMessage[] {
  const rules = [
    'You merge notes on consecutive parts of a long meeting into one shorter set of notes, to be combined into the meeting notes later.',
    '',
    'Rules:',
    '- Keep every decision and every task with its owner, and keep names, numbers and dates. Merge points that repeat.',
    '- Output only Markdown bullets. Never invent facts.',
    '- Write in the language of the notes.',
    ...spellingRule(input.dictionary),
  ]
  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: formatParts(parts) },
  ]
}

/** Some models wrap the whole answer in a fenced Markdown block. */
export function sanitizeSummary(output: string): string {
  return output
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1')
    .trim()
}
