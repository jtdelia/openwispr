import { Key } from './keycodes'

export type ShortcutAction = 'ptt' | 'handsFree' | 'pasteLast' | 'copyLast'

export type Shortcuts = Record<ShortcutAction, number[]>

export const DEFAULT_SHORTCUTS: Shortcuts = {
  ptt: [Key.fn],
  handsFree: [Key.fn, Key.space],
  pasteLast: [Key.ctrl, Key.cmd, Key.v],
  copyLast: [Key.ctrl, Key.cmd, Key.c],
}

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  ptt: 'Push to talk (hold)',
  handsFree: 'Hands-free mode',
  pasteLast: 'Paste last transcript',
  copyLast: 'Copy last transcript',
}

export type StyleContext = 'personal' | 'work' | 'email' | 'other'
export type Style = 'formal' | 'casual' | 'veryCasual' | 'excited'

export const STYLE_CONTEXTS: StyleContext[] = ['personal', 'work', 'email', 'other']
export const STYLES: Style[] = ['formal', 'casual', 'veryCasual', 'excited']

export type AppCategory = 'email' | 'ai' | 'terminal' | 'messaging' | 'other'

/** Self-hosted servers usually don't require an API key. */
export function isLocalEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseUrl)
}

export interface ProviderConfig {
  baseUrl: string
  model: string
  /** Encrypted at rest; plaintext only ever lives in the main process. */
  apiKey: string
}

export interface Settings {
  transcription: ProviderConfig & { language: string }
  cleanup: ProviderConfig & { enabled: boolean }
  shortcuts: Shortcuts
  styles: Record<StyleContext, Style>
  microphoneId: string
  sounds: boolean
  restoreClipboard: boolean
  showFlowBar: boolean
  launchAtLogin: boolean
  userName: string
}

/** What the renderer sees: API keys are replaced by a presence flag. */
export type PublicSettings = Omit<Settings, 'transcription' | 'cleanup'> & {
  transcription: Omit<Settings['transcription'], 'apiKey'> & { hasApiKey: boolean }
  cleanup: Omit<Settings['cleanup'], 'apiKey'> & { hasApiKey: boolean }
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K]
}

export interface DictionaryEntry {
  id: string
  /** Spelling the transcript should use. */
  word: string
  /** Optional: what the ASR tends to produce instead; replaced verbatim with `word`. */
  replaces?: string
}

export interface Snippet {
  id: string
  trigger: string
  expansion: string
}

export type DictationMode = 'ptt' | 'handsFree'
export type HistoryStatus = 'pasted' | 'copied' | 'empty' | 'error' | 'cancelled'

export interface HistoryEntry {
  id: string
  timestamp: number
  mode: DictationMode
  status: HistoryStatus
  asrText: string
  formattedText: string
  appName: string
  bundleId: string
  durationMs: number
  numWords: number
  error?: string
}

export type FlowBarState =
  | { kind: 'hidden' }
  | { kind: 'resting' }
  | { kind: 'initializing'; mode: DictationMode }
  | { kind: 'listening'; mode: DictationMode }
  | { kind: 'processing' }
  | { kind: 'notice'; message: string; tone: 'info' | 'error' }

export interface PermissionStatus {
  helperRunning: boolean
  accessibility: boolean
  keyTapRunning: boolean
  microphone: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
}

export interface Stats {
  totalWords: number
  totalDictations: number
  averageWpm: number
}

/** `mic` is the user; `system` is everything the Mac plays, i.e. the other meeting participants. */
export type TranscriptSource = 'mic' | 'system'

export interface TranscriptEntry {
  id: string
  source: TranscriptSource
  text: string
  /** Offsets into the meeting's total recorded time, so resumed recordings continue the timeline. */
  startMs: number
  endMs: number
  /** Who spoke on the call audio, as a speaker key (see `speakers.ts`); absent when unknown. */
  speaker?: string
}

export type MeetingPlatform = 'zoom' | 'teams' | 'meet' | 'slack'

/** Who the meeting app shows as talking right now. */
export interface LiveSpeakers {
  platform: MeetingPlatform | null
  speaking: string[]
}

export interface Meeting {
  id: string
  title: string
  createdAt: number
  modifiedAt: number
  /** The user's own notes, plain text. The AI summary is kept separately and never merged in. */
  notes: string
  /** Markdown, or null until one has been generated. */
  summary: string | null
  /** `recordedMs` when the summary was generated; less than `recordedMs` means new audio since. */
  summaryRecordedMs: number
  summaryError: string | null
  summaryGenerating: boolean
  recordedMs: number
  transcriptWords: number
  /** Names the user gave speakers, by speaker key; they override the detected labels everywhere. */
  speakerNames: Record<string, string>
}

export interface MeetingDetail extends Meeting {
  transcript: TranscriptEntry[]
}

export type MeetingPatch = Partial<Pick<Meeting, 'title' | 'notes' | 'speakerNames'>>

export type NotetakerState =
  | { kind: 'idle'; error?: string }
  | {
      kind: 'recording'
      meetingId: string
      startedAt: number
      baseRecordedMs: number
      systemAudio: SystemAudioStatus
      speakers: LiveSpeakers
      /** Latest chunk transcription failure; cleared by the next success. */
      error?: string
    }
  | { kind: 'finishing'; meetingId: string }

export type SystemAudioStatus = { kind: 'starting' } | { kind: 'capturing' } | { kind: 'unavailable'; reason: string }
