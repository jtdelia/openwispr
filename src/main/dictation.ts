import { clipboard } from 'electron'
import { Channel, type RecorderEvent, type Sound } from '../shared/api'
import { Key } from '../shared/keycodes'
import type { DictationMode, HistoryEntry, HistoryStatus } from '../shared/types'
import type { AppInfo, Helper, TextBoxInfo } from './helper'
import type { Models } from './models'
import type { Gesture, ShortcutEngine } from './shortcutEngine'
import type { Store } from './store'
import {
  appCategory,
  applyReplacements,
  applySnippets,
  countWords,
  joinWithContext,
  styleContext,
  transcriptionPrompt,
  wholeSnippet,
} from './textProcessing'
import type { Windows } from './windows'

/** Matches Wispr Flow's DICTATION_DEBOUNCE_DELAY: shorter push-to-talk holds are treated as accidental taps. */
const PTT_MIN_HOLD_MS = 500
const MAX_RECORDING_MS = 10 * 60_000
const NOTICE_MS = 2500
/** 16 kHz mono PCM16 WAV: 44-byte header plus ~0.25 s of audio. */
const MIN_WAV_BYTES = 44 + 16000 * 2 * 0.25

type Phase =
  | { kind: 'idle' }
  | { kind: 'recording'; session: number; mode: DictationMode; startedAt: number; context: Promise<FocusContext> }
  | { kind: 'processing'; session: number; mode: DictationMode; durationMs: number; context: Promise<FocusContext> }

interface FocusContext {
  app: AppInfo
  textBox: TextBoxInfo | null
}

const UNKNOWN_APP: AppInfo = { appName: '', bundleId: '', windowTitle: '' }

export class DictationController {
  private phase: Phase = { kind: 'idle' }
  private session = 0
  private maxTimer: NodeJS.Timeout | null = null
  private noticeTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly helper: Helper,
    private readonly store: Store,
    private readonly models: Models,
    private readonly windows: Windows,
    private readonly engine: ShortcutEngine,
  ) {}

  handleGesture(gesture: Gesture): void {
    switch (gesture) {
      case 'pttStart':
        this.start('ptt')
        return
      case 'handsFreeStart':
        this.start('handsFree')
        return
      case 'handsFreeLock':
        this.lockHandsFree()
        return
      case 'pttEnd': {
        if (this.phase.kind !== 'recording' || this.phase.mode !== 'ptt') return
        if (Date.now() - this.phase.startedAt < PTT_MIN_HOLD_MS) this.cancel()
        else this.stop()
        return
      }
      case 'handsFreeStop':
        this.stop()
        return
      case 'pttAbort':
      case 'dismiss':
        this.cancel()
        return
      case 'pasteLast':
        void this.pasteLast()
        return
      case 'copyLast':
        this.copyLast()
        return
      default: {
        const unreachable: never = gesture
        throw new Error(`unhandled gesture ${String(unreachable)}`)
      }
    }
  }

  get isActive(): boolean {
    return this.phase.kind !== 'idle'
  }

  start(mode: DictationMode): void {
    if (this.phase.kind !== 'idle') return
    const settings = this.store.settings
    const speechToText = this.models.availability('speechToText')
    if (!speechToText.available) {
      this.engine.reset()
      this.notice(speechToText.reason, 'error')
      this.windows.showHub().webContents.send(Channel.dataChanged, 'settings')
      return
    }
    this.models.warmUp()
    const session = ++this.session
    this.phase = { kind: 'recording', session, mode, startedAt: Date.now(), context: this.captureContext() }
    this.windows.setFlowBarState({ kind: 'initializing', mode })
    this.windows.flowBar.webContents.send(Channel.recorderCommand, { type: 'start', deviceId: settings.microphoneId })
    this.playSound('start')
    this.syncHelperShortcuts()
    this.maxTimer = setTimeout(() => this.stop(), MAX_RECORDING_MS)
  }

  private lockHandsFree(): void {
    if (this.phase.kind !== 'recording') return
    this.phase = { ...this.phase, mode: 'handsFree' }
    this.windows.setFlowBarState({ kind: 'listening', mode: 'handsFree' })
    this.playSound('lock')
  }

  stop(): void {
    if (this.phase.kind !== 'recording') return
    this.clearMaxTimer()
    const { session, mode, startedAt, context } = this.phase
    this.phase = { kind: 'processing', session, mode, durationMs: Date.now() - startedAt, context }
    this.engine.reset()
    this.windows.setFlowBarState({ kind: 'processing' })
    this.windows.flowBar.webContents.send(Channel.recorderCommand, { type: 'stop' })
    this.playSound('stop')
    this.syncHelperShortcuts()
  }

  cancel(): void {
    if (this.phase.kind === 'idle') return
    this.clearMaxTimer()
    if (this.phase.kind === 'recording') {
      this.windows.flowBar.webContents.send(Channel.recorderCommand, { type: 'cancel' })
    }
    this.phase = { kind: 'idle' }
    this.engine.reset()
    this.windows.setFlowBarState({ kind: 'resting' })
    this.syncHelperShortcuts()
  }

  handleRecorderEvent(event: RecorderEvent): void {
    switch (event.type) {
      case 'started':
        if (this.phase.kind === 'recording') {
          this.windows.setFlowBarState({ kind: 'listening', mode: this.phase.mode })
        }
        return
      case 'error':
        if (this.phase.kind === 'idle') return
        this.clearMaxTimer()
        this.phase = { kind: 'idle' }
        this.engine.reset()
        this.syncHelperShortcuts()
        this.playSound('error')
        this.notice(`Microphone error: ${event.message}`, 'error')
        return
      default: {
        const unreachable: never = event
        throw new Error(`unhandled recorder event ${JSON.stringify(unreachable)}`)
      }
    }
  }

  async handleAudio(wav: Buffer): Promise<void> {
    if (this.phase.kind !== 'processing') return
    const { session, mode, durationMs, context } = this.phase
    const isCurrent = () => this.phase.kind === 'processing' && this.phase.session === session
    const settings = this.store.settings
    const focus = await context
    const base = {
      timestamp: Date.now(),
      mode,
      appName: focus.app.appName,
      bundleId: focus.app.bundleId,
      durationMs,
    }

    if (wav.byteLength < MIN_WAV_BYTES) {
      this.finish('No audio captured', 'info')
      return
    }

    let asrText = ''
    try {
      asrText = await this.models.transcribe(wav, {
        prompt: transcriptionPrompt(this.store.dictionary, settings.userName),
      })
      if (!isCurrent()) return
      const { text, notice } = asrText ? await this.format(asrText, focus) : { text: '', notice: null }
      if (!isCurrent()) return

      if (!text.trim()) {
        this.record({ ...base, status: 'empty', asrText, formattedText: '' })
        this.finish('No speech detected', 'info')
        return
      }

      const formattedText = joinWithContext(text, focus.textBox?.beforeText ?? '')
      const status = await this.insert(formattedText, focus.textBox)
      this.record({ ...base, status, asrText, formattedText: formattedText.trim() })
      const copiedMessage = focus.textBox?.accessibilityIsFunctioning
        ? 'No text field focused. Copied to clipboard'
        : 'Copied. Grant Accessibility to auto-paste'
      this.finish(status === 'copied' ? copiedMessage : notice, 'info')
    } catch (error) {
      if (!isCurrent()) return
      const message = error instanceof Error ? error.message : String(error)
      console.error('[dictation] failed', error)
      this.playSound('error')
      this.record({ ...base, status: 'error', asrText, formattedText: asrText, error: message })
      this.finish(message, 'error')
    }
  }

  /** The text to insert, and why Cleanup didn't run when the user should know. */
  private async format(asrText: string, focus: FocusContext): Promise<{ text: string; notice: string | null }> {
    const { dictionary, snippets } = this.store
    const settings = this.store.settings
    const snippet = wholeSnippet(asrText, snippets)
    if (snippet !== null) return { text: snippet, notice: null }

    let text = applyReplacements(asrText, dictionary)
    let notice: string | null = null
    if (settings.cleanup.enabled && this.models.availability('chat').available) {
      const category = appCategory(focus.app.bundleId, focus.app.windowTitle)
      const cleaned = await this.models.cleanup({
        transcript: text,
        style: settings.styles[styleContext(category, focus.app.bundleId, focus.app.windowTitle)],
        category,
        beforeText: focus.textBox?.beforeText ?? '',
        dictionary,
        userName: settings.userName,
      })
      text = applyReplacements(cleaned.text, dictionary)
      notice = cleaned.notice
    }
    return { text: applySnippets(text, snippets), notice }
  }

  private async insert(text: string, textBox: TextBoxInfo | null): Promise<HistoryStatus> {
    // Synthesized Cmd+V is silently dropped without Accessibility, so fall back to the clipboard.
    // Otherwise only skip pasting when AX positively reports a non-editable focus; many apps don't expose AX.
    const cannotPaste =
      textBox === null ||
      !textBox.accessibilityIsFunctioning ||
      (!textBox.couldNotGetTextBoxInfo && !textBox.isEditable)
    if (!cannotPaste) {
      const result = await this.helper
        .request<{ success: boolean }>('paste', { text, restoreClipboard: this.store.settings.restoreClipboard })
        .catch(() => ({ success: false }))
      if (result.success) return 'pasted'
    }
    clipboard.writeText(text.trim())
    return 'copied'
  }

  private record(entry: Omit<HistoryEntry, 'id' | 'numWords'>): void {
    this.store.addHistory({ ...entry, numWords: countWords(entry.formattedText) })
    this.windows.broadcast(Channel.dataChanged, 'history')
  }

  private finish(message: string | null, tone: 'info' | 'error'): void {
    this.phase = { kind: 'idle' }
    this.syncHelperShortcuts()
    if (message) this.notice(message, tone)
    else this.windows.setFlowBarState({ kind: 'resting' })
  }

  private async pasteLast(): Promise<void> {
    const text = this.store.lastText()
    if (!text || this.phase.kind !== 'idle') return
    await this.helper.request('paste', { text, restoreClipboard: this.store.settings.restoreClipboard })
  }

  private copyLast(): void {
    const text = this.store.lastText()
    if (!text) return
    clipboard.writeText(text)
    this.notice('Copied last transcript', 'info')
  }

  private async captureContext(): Promise<FocusContext> {
    const [app, textBox] = await Promise.all([
      this.helper.request<AppInfo>('getAppInfo').catch(() => UNKNOWN_APP),
      this.helper.request<TextBoxInfo>('getTextBoxInfo').catch(() => null),
    ])
    return { app, textBox }
  }

  /** The helper swallows keys that complete these combos; Esc is only claimed while dictating. */
  syncHelperShortcuts(): void {
    const { shortcuts } = this.store.settings
    const combos: number[][] = Object.values(shortcuts).filter((c) => c.length > 0)
    if (this.phase.kind !== 'idle') combos.push([Key.esc])
    void this.helper.request('setShortcuts', { combos }).catch(() => undefined)
  }

  private notice(message: string, tone: 'info' | 'error'): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.windows.setFlowBarState({ kind: 'notice', message, tone })
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null
      if (this.phase.kind === 'idle') this.windows.setFlowBarState({ kind: 'resting' })
    }, NOTICE_MS)
  }

  private playSound(sound: Sound): void {
    if (this.store.settings.sounds) this.windows.flowBar.webContents.send(Channel.sound, sound)
  }

  private clearMaxTimer(): void {
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = null
  }
}
