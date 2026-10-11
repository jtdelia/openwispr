import type { Meeting } from './types'

/** Below this many transcribed words there is nothing worth summarizing. */
export const MIN_SUMMARY_WORDS = 20

/** Mirrors the summary states Wispr Flow's meeting view renders. */
export type SummaryState =
  | { kind: 'not-yet-generatable' }
  | { kind: 'too-short'; noAudio: boolean }
  | { kind: 'ready-to-generate' }
  | { kind: 'generating' }
  | { kind: 'generated'; summary: string }
  | { kind: 'update-available'; summary: string }
  | { kind: 'updating'; summary: string }
  | { kind: 'failed'; summary: string | null; error: string }

export function summaryState(meeting: Meeting, recording: boolean): SummaryState {
  const { summary } = meeting
  if (meeting.summaryGenerating) return summary === null ? { kind: 'generating' } : { kind: 'updating', summary }
  if (meeting.summaryError) return { kind: 'failed', summary, error: meeting.summaryError }
  if (summary !== null) {
    return meeting.recordedMs > meeting.summaryRecordedMs && !recording
      ? { kind: 'update-available', summary }
      : { kind: 'generated', summary }
  }
  if (recording) return { kind: 'not-yet-generatable' }
  if (meeting.transcriptWords < MIN_SUMMARY_WORDS) {
    return { kind: 'too-short', noAudio: meeting.recordedMs === 0 || meeting.transcriptWords === 0 }
  }
  return { kind: 'ready-to-generate' }
}
