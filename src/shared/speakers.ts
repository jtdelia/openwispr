import type { MeetingPlatform, TranscriptEntry } from './types'

/**
 * Speaker keys identify who said a transcript entry:
 * - `you`: the user's microphone.
 * - `app:<name>`: a participant the meeting app showed as talking.
 * - `voice:<n>`: a distinct voice on the call audio, told apart by diarization.
 * - `others`: call audio nobody could be attributed to.
 */
export const YOU = 'you'
export const OTHERS = 'others'

export const appSpeaker = (name: string): string => `app:${name}`
export const voiceSpeaker = (id: number): string => `voice:${id}`

export function voiceId(key: string): number | null {
  const match = /^voice:(\d+)$/.exec(key)
  return match ? Number(match[1]) : null
}

export const PLATFORM_LABEL: Record<MeetingPlatform, string> = {
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
  meet: 'Google Meet',
  slack: 'Slack huddle',
}

export function speakerKey(entry: Pick<TranscriptEntry, 'source' | 'speaker'>): string {
  return entry.source === 'mic' ? YOU : (entry.speaker ?? OTHERS)
}

export function defaultSpeakerLabel(key: string, userName: string): string {
  if (key === YOU) return userName.trim() ? `${userName.trim()} (me)` : 'Me'
  if (key.startsWith('app:')) return key.slice('app:'.length)
  const voice = voiceId(key)
  return voice === null ? 'Others' : `Speaker ${voice}`
}

export function speakerLabel(key: string, names: Record<string, string>, userName: string): string {
  return names[key]?.trim() || defaultSpeakerLabel(key, userName)
}

export interface TranscriptTurn {
  id: string
  speaker: string
  startMs: number
  text: string
}

/** Consecutive entries from the same speaker merged into one turn, without microphone echoes. */
export function transcriptTurns(entries: TranscriptEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const entry of withoutEchoes(entries)) {
    const speaker = speakerKey(entry)
    const last = turns.at(-1)
    if (last && last.speaker === speaker) last.text += ` ${entry.text}`
    else turns.push({ id: entry.id, speaker, startMs: entry.startMs, text: entry.text })
  }
  return turns
}

const ECHO_WINDOW_MS = 3000
const ECHO_MIN_WORDS = 3
const ECHO_OVERLAP = 0.7

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Drops microphone entries that repeat what the call audio said at the same time: speakers playing into
 * an open microphone, which echo cancellation does not always remove.
 */
export function withoutEchoes(entries: TranscriptEntry[]): TranscriptEntry[] {
  const system = entries.filter((e) => e.source === 'system')
  if (system.length === 0) return entries
  return entries.filter((entry) => {
    if (entry.source !== 'mic') return true
    const mine = words(entry.text)
    if (mine.length < ECHO_MIN_WORDS) return true
    const heard = new Set(
      system
        .filter((s) => s.startMs < entry.endMs + ECHO_WINDOW_MS && s.endMs > entry.startMs - ECHO_WINDOW_MS)
        .flatMap((s) => words(s.text)),
    )
    const repeated = mine.filter((word) => heard.has(word)).length
    return repeated / mine.length < ECHO_OVERLAP
  })
}
