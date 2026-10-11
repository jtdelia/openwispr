import type {
  DictionaryEntry,
  EndpointTestResult,
  FlowBarState,
  HistoryEntry,
  Meeting,
  MeetingDetail,
  MeetingPatch,
  ModelRole,
  NotetakerState,
  PermissionStatus,
  PublicSettings,
  SettingsPatch,
  Snippet,
  Stats,
  TranscriptSource,
} from './types'

export type DataTopic = 'settings' | 'history' | 'dictionary' | 'snippets' | 'permissions' | 'meetings' | 'notetaker'

export type RecorderCommand =
  | { type: 'start'; deviceId: string }
  | { type: 'stop' }
  | { type: 'cancel' }

export type RecorderEvent = { type: 'started' } | { type: 'error'; message: string }

export type Sound = 'start' | 'stop' | 'lock' | 'error'

/** `session` ties every message to one recording segment so late chunks from a stopped segment are dropped. */
export type MeetingRecorderCommand =
  | { type: 'start'; session: number; deviceId: string }
  | { type: 'stop'; session: number }
  /** The speaker changed: end the current chunk at the next short pause so it holds one voice. */
  | { type: 'cut'; session: number; source: TranscriptSource }

export type MeetingRecorderEvent =
  | { type: 'started'; session: number; systemAudioError: string | null }
  | { type: 'error'; session: number; message: string }
  | { type: 'stopped'; session: number }

export interface MeetingChunk {
  session: number
  source: TranscriptSource
  /** Offsets from the start of this recording segment, shared by both sources. */
  startMs: number
  endMs: number
  /** Epoch ms at `startMs`, to line the audio up with speaker observations. */
  wallClockMs: number
  wav: ArrayBuffer
}

export type FlowBarAction = 'startHandsFree' | 'stop' | 'cancel' | 'openHub'

export interface OpenWisprApi {
  getSettings(): Promise<PublicSettings>
  updateSettings(patch: SettingsPatch): Promise<PublicSettings>
  testEndpoint(role: ModelRole): Promise<EndpointTestResult>
  getHistory(): Promise<HistoryEntry[]>
  deleteHistoryEntry(id: string): Promise<void>
  clearHistory(): Promise<void>
  getStats(): Promise<Stats>
  getDictionary(): Promise<DictionaryEntry[]>
  saveDictionary(entries: DictionaryEntry[]): Promise<void>
  getSnippets(): Promise<Snippet[]>
  saveSnippets(snippets: Snippet[]): Promise<void>
  getPermissions(): Promise<PermissionStatus>
  requestAccessibility(): Promise<PermissionStatus>
  requestMicrophone(): Promise<PermissionStatus>
  copyText(text: string): Promise<void>
  startShortcutCapture(): Promise<void>
  stopShortcutCapture(): Promise<void>
  onShortcutCapture(listener: (heldKeys: number[]) => void): () => void
  onDataChanged(listener: (topic: DataTopic) => void): () => void

  getMeetings(): Promise<Meeting[]>
  getMeeting(id: string): Promise<MeetingDetail | null>
  createMeeting(): Promise<Meeting>
  updateMeeting(id: string, patch: MeetingPatch): Promise<void>
  deleteMeeting(id: string): Promise<void>
  generateMeetingSummary(id: string): Promise<void>
  getNotetakerState(): Promise<NotetakerState>
  startMeetingRecording(id: string): Promise<void>
  stopMeetingRecording(): Promise<void>

  onFlowBarState(listener: (state: FlowBarState) => void): () => void
  onRecorderCommand(listener: (command: RecorderCommand) => void): () => void
  onSound(listener: (sound: Sound) => void): () => void
  sendRecorderEvent(event: RecorderEvent): void
  submitAudio(wav: ArrayBuffer): void
  setFlowBarInteractive(interactive: boolean): void
  flowBarAction(action: FlowBarAction): void

  onMeetingRecorderCommand(listener: (command: MeetingRecorderCommand) => void): () => void
  sendMeetingRecorderEvent(event: MeetingRecorderEvent): void
  submitMeetingChunk(chunk: MeetingChunk): void
}

/** IPC channel names, shared by main and preload. */
export const Channel = {
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  testEndpoint: 'models:test-endpoint',
  getHistory: 'history:get',
  deleteHistoryEntry: 'history:delete',
  clearHistory: 'history:clear',
  getStats: 'stats:get',
  getDictionary: 'dictionary:get',
  saveDictionary: 'dictionary:save',
  getSnippets: 'snippets:get',
  saveSnippets: 'snippets:save',
  getPermissions: 'permissions:get',
  requestAccessibility: 'permissions:accessibility',
  requestMicrophone: 'permissions:microphone',
  copyText: 'clipboard:copy',
  startShortcutCapture: 'shortcuts:capture-start',
  stopShortcutCapture: 'shortcuts:capture-stop',
  shortcutCapture: 'shortcuts:capture',
  dataChanged: 'data:changed',
  flowBarState: 'flowbar:state',
  recorderCommand: 'recorder:command',
  recorderEvent: 'recorder:event',
  sound: 'sound:play',
  submitAudio: 'recorder:audio',
  setFlowBarInteractive: 'flowbar:interactive',
  flowBarAction: 'flowbar:action',
  getMeetings: 'meetings:list',
  getMeeting: 'meetings:get',
  createMeeting: 'meetings:create',
  updateMeeting: 'meetings:update',
  deleteMeeting: 'meetings:delete',
  generateMeetingSummary: 'meetings:summarize',
  getNotetakerState: 'notetaker:state',
  startMeetingRecording: 'notetaker:start',
  stopMeetingRecording: 'notetaker:stop',
  meetingRecorderCommand: 'meeting-recorder:command',
  meetingRecorderEvent: 'meeting-recorder:event',
  submitMeetingChunk: 'meeting-recorder:chunk',
} as const
