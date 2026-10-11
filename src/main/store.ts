import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import {
  DEFAULT_SHORTCUTS,
  type DictionaryEntry,
  type HistoryEntry,
  type PublicSettings,
  type Settings,
  type SettingsPatch,
  type Snippet,
  type Stats,
} from '../shared/types'

const HISTORY_LIMIT = 2000
const ENCRYPTED_PREFIX = 'enc:'

export const DEFAULT_SETTINGS: Settings = {
  transcription: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', apiKey: '', language: '' },
  cleanup: { enabled: true, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: '' },
  shortcuts: DEFAULT_SHORTCUTS,
  styles: { personal: 'casual', work: 'casual', email: 'formal', other: 'casual' },
  microphoneId: '',
  sounds: true,
  restoreClipboard: true,
  showFlowBar: true,
  launchAtLogin: false,
  userName: '',
}

interface Data {
  settings: Settings
  dictionary: DictionaryEntry[]
  snippets: Snippet[]
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

function encrypt(secret: string): string {
  if (!secret) return ''
  if (!safeStorage.isEncryptionAvailable()) return secret
  return ENCRYPTED_PREFIX + safeStorage.encryptString(secret).toString('base64')
}

function decrypt(stored: string): string {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const merged = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key]
    merged[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
        ? { ...current, ...value }
        : value
  }
  return merged as unknown as Settings
}

export class Store {
  private readonly dataPath = join(app.getPath('userData'), 'openwispr.json')
  private readonly historyPath = join(app.getPath('userData'), 'history.json')
  private data: Data
  private history: HistoryEntry[]
  private historyWrite: NodeJS.Timeout | null = null

  constructor() {
    const stored = readJson<Partial<Data>>(this.dataPath, {})
    this.data = {
      settings: mergeSettings(DEFAULT_SETTINGS, (stored.settings ?? {}) as SettingsPatch),
      dictionary: stored.dictionary ?? [],
      snippets: stored.snippets ?? [],
    }
    this.history = readJson<HistoryEntry[]>(this.historyPath, [])
  }

  /** Settings with decrypted API keys. Never send this to a renderer. */
  get settings(): Settings {
    const { transcription, cleanup } = this.data.settings
    const transcriptionKey = decrypt(transcription.apiKey)
    const cleanupKey = decrypt(cleanup.apiKey)
    return {
      ...this.data.settings,
      transcription: { ...transcription, apiKey: transcriptionKey },
      cleanup: {
        ...cleanup,
        apiKey: cleanupKey || (cleanup.baseUrl === transcription.baseUrl ? transcriptionKey : ''),
      },
    }
  }

  get publicSettings(): PublicSettings {
    const { transcription, cleanup, ...rest } = this.settings
    const { apiKey: transcriptionKey, ...publicTranscription } = transcription
    const { apiKey: cleanupKey, ...publicCleanup } = cleanup
    return {
      ...rest,
      transcription: { ...publicTranscription, hasApiKey: Boolean(transcriptionKey) },
      cleanup: { ...publicCleanup, hasApiKey: Boolean(cleanupKey) },
    }
  }

  updateSettings(patch: SettingsPatch): void {
    const encryptedPatch: SettingsPatch = { ...patch }
    if (patch.transcription?.apiKey !== undefined) {
      encryptedPatch.transcription = { ...patch.transcription, apiKey: encrypt(patch.transcription.apiKey) }
    }
    if (patch.cleanup?.apiKey !== undefined) {
      encryptedPatch.cleanup = { ...patch.cleanup, apiKey: encrypt(patch.cleanup.apiKey) }
    }
    this.data.settings = mergeSettings(this.data.settings, encryptedPatch)
    this.save()
  }

  get dictionary(): DictionaryEntry[] {
    return this.data.dictionary
  }

  setDictionary(entries: DictionaryEntry[]): void {
    this.data.dictionary = entries.filter((e) => e.word.trim())
    this.save()
  }

  get snippets(): Snippet[] {
    return this.data.snippets
  }

  setSnippets(snippets: Snippet[]): void {
    this.data.snippets = snippets.filter((s) => s.trigger.trim())
    this.save()
  }

  getHistory(): HistoryEntry[] {
    return this.history
  }

  addHistory(entry: Omit<HistoryEntry, 'id'>): HistoryEntry {
    const full = { ...entry, id: randomUUID() }
    this.history = [full, ...this.history].slice(0, HISTORY_LIMIT)
    this.saveHistory()
    return full
  }

  deleteHistory(id: string): void {
    this.history = this.history.filter((h) => h.id !== id)
    this.saveHistory()
  }

  clearHistory(): void {
    this.history = []
    this.saveHistory()
  }

  /** Most recent text that was actually produced, for paste-last and copy-last. */
  lastText(): string | null {
    return this.history.find((h) => h.formattedText)?.formattedText ?? null
  }

  stats(): Stats {
    const done = this.history.filter((h) => h.status === 'pasted' || h.status === 'copied')
    const totalWords = done.reduce((sum, h) => sum + h.numWords, 0)
    const minutes = done.reduce((sum, h) => sum + h.durationMs, 0) / 60000
    return {
      totalWords,
      totalDictations: done.length,
      averageWpm: minutes > 0 ? Math.round(totalWords / minutes) : 0,
    }
  }

  private save(): void {
    writeJsonAtomic(this.dataPath, this.data)
  }

  private saveHistory(): void {
    if (this.historyWrite) clearTimeout(this.historyWrite)
    this.historyWrite = setTimeout(() => {
      this.historyWrite = null
      writeJsonAtomic(this.historyPath, this.history)
    }, 250)
  }

  flush(): void {
    if (!this.historyWrite) return
    clearTimeout(this.historyWrite)
    this.historyWrite = null
    writeJsonAtomic(this.historyPath, this.history)
  }
}
