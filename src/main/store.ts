import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import {
  MODEL_ROLES,
  type DictionaryEntry,
  type HistoryEntry,
  type ModelSelection,
  type ModelSelectionPatch,
  type PublicModelSelection,
  type PublicSettings,
  type Settings,
  type SettingsPatch,
  type Snippet,
  type Stats,
} from '../shared/types'
import { applySettingsPatch, loadSettings } from './settings'

const HISTORY_LIMIT = 2000
const ENCRYPTED_PREFIX = 'enc:'

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

function decryptSelection(selection: ModelSelection): ModelSelection {
  return selection.kind === 'endpoint' ? { ...selection, apiKey: decrypt(selection.apiKey) } : selection
}

function publicSelection(selection: ModelSelection): PublicModelSelection {
  if (selection.kind !== 'endpoint') return selection
  const { apiKey, ...rest } = selection
  return { ...rest, hasApiKey: Boolean(apiKey) }
}

function encryptSelectionPatch(patch: ModelSelectionPatch): ModelSelectionPatch {
  return patch.kind === 'endpoint' && patch.apiKey !== undefined ? { ...patch, apiKey: encrypt(patch.apiKey) } : patch
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
      settings: loadSettings((stored.settings ?? {}) as Record<string, unknown>),
      dictionary: stored.dictionary ?? [],
      snippets: stored.snippets ?? [],
    }
    this.history = readJson<HistoryEntry[]>(this.historyPath, [])
  }

  /** Settings with decrypted API keys. Never send this to a renderer. */
  get settings(): Settings {
    const { speechToText, chat } = this.data.settings
    return { ...this.data.settings, speechToText: decryptSelection(speechToText), chat: decryptSelection(chat) }
  }

  get publicSettings(): PublicSettings {
    const { speechToText, chat, ...rest } = this.data.settings
    return { ...rest, speechToText: publicSelection(speechToText), chat: publicSelection(chat) }
  }

  updateSettings(patch: SettingsPatch): void {
    const encryptedPatch: SettingsPatch = { ...patch }
    for (const role of MODEL_ROLES) {
      const selection = patch[role]
      if (selection) encryptedPatch[role] = encryptSelectionPatch(selection)
    }
    this.data.settings = applySettingsPatch(this.data.settings, encryptedPatch)
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
