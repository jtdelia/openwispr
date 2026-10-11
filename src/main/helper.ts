import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { app } from 'electron'
import type { MeetingPlatform } from '../shared/types'
import { HELPER, nativeExecutablePath } from './nativeExecutables'

export interface TextBoxInfo {
  accessibilityIsFunctioning: boolean
  couldNotGetTextBoxInfo: boolean
  isEditable: boolean
  contents: string
  beforeText: string
  afterText: string
  selectedText: string
}

export interface AppInfo {
  appName: string
  bundleId: string
  windowTitle: string
}

export interface SpeakersReport {
  /** Epoch ms when the meeting app was read. */
  timestamp: number
  platform: MeetingPlatform | null
  /** Other participants shown talking; the user is reported separately. */
  speaking: string[]
  selfSpeaking: boolean
}

type HelperMessage =
  | { type: 'ready'; trusted: boolean; keyTapRunning: boolean }
  | { type: 'key'; keycode: number; down: boolean }
  | { type: 'tapReset' }
  | { type: 'appInfo'; info: AppInfo }
  | ({ type: 'speakers' } & SpeakersReport)
  | { type: 'response'; id: number; result?: unknown; error?: string }

interface HelperEvents {
  ready: [{ trusted: boolean; keyTapRunning: boolean }]
  key: [keycode: number, down: boolean]
  tapReset: []
  appInfo: [AppInfo]
  speakers: [SpeakersReport]
  exit: []
}

const REQUEST_TIMEOUT_MS = 3000
const RESTART_DELAYS_MS = [500, 1000, 2000, 5000, 10000]

/** Owns the Swift helper process and its newline-delimited JSON protocol. */
export class Helper extends EventEmitter<HelperEvents> {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private restarts = 0
  private stopping = false

  get running(): boolean {
    return this.child !== null
  }

  start(): void {
    const path = nativeExecutablePath(HELPER, {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    })
    if (!existsSync(path)) {
      console.error(`[helper] binary not found at ${path}; run "npm run helper:build"`)
      return
    }
    const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.on('exit', (code, signal) => {
      this.child = null
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('helper exited'))
      }
      this.pending.clear()
      this.emit('exit')
      if (this.stopping) return
      const delay = RESTART_DELAYS_MS[Math.min(this.restarts++, RESTART_DELAYS_MS.length - 1)]
      console.warn(`[helper] exited (code=${code} signal=${signal}); restarting in ${delay}ms`)
      setTimeout(() => this.start(), delay)
    })
  }

  stop(): void {
    this.stopping = true
    this.child?.stdin.end()
    this.child?.kill()
  }

  request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const child = this.child
    if (!child) return Promise.reject(new Error('helper is not running'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`helper request ${type} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`)
    })
  }

  private onLine(line: string): void {
    let message: HelperMessage
    try {
      message = JSON.parse(line) as HelperMessage
    } catch {
      console.warn('[helper] unparseable line', line)
      return
    }
    switch (message.type) {
      case 'ready':
        this.restarts = 0
        this.emit('ready', { trusted: message.trusted, keyTapRunning: message.keyTapRunning })
        return
      case 'key':
        this.emit('key', message.keycode, message.down)
        return
      case 'tapReset':
        this.emit('tapReset')
        return
      case 'appInfo':
        this.emit('appInfo', message.info)
        return
      case 'speakers':
        this.emit('speakers', {
          timestamp: message.timestamp,
          platform: message.platform,
          speaking: message.speaking,
          selfSpeaking: message.selfSpeaking,
        })
        return
      case 'response': {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(message.error))
        else entry.resolve(message.result)
        return
      }
      default: {
        const unknownMessage: never = message
        console.warn('[helper] unknown message', unknownMessage)
      }
    }
  }
}
