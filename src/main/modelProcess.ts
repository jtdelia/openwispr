import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { BuiltInStatus, ModelProgress, ModelRole } from '../shared/types'
import type { ChatMessage } from './providers'

/** A model to have ready before it's needed. `id` is `apple` or a downloaded model's id. */
export type ModelRef = { role: ModelRole; id: string; language: string }

/** What the main process asks the model process; `audio` is a base64 16 kHz mono PCM16 WAV. */
export type ModelRequestBody =
  | { type: 'transcribe'; model: string; audio: string; language: string; prompt: string; segments: boolean }
  | { type: 'complete'; model: string; messages: ChatMessage[]; maxTokens: number }
  | { type: 'load'; models: ModelRef[] }
  | { type: 'unload'; models: string[] }
  /** `speechToText` and `chat` are the selected downloaded models, if any. */
  | { type: 'status'; language: string; speechToText?: string; chat?: string }

export type ModelRequest = ModelRequestBody & { id: number }

export interface TranscribeResult {
  text: string
  /** Seconds from the start of the audio; present when `segments` was asked for. */
  segments?: Array<{ start: number; end: number; text: string }>
}

export interface ModelResults {
  transcribe: TranscribeResult
  complete: { text: string }
  load: Record<string, never>
  unload: Record<string, never>
  status: BuiltInStatus
}

export type ModelErrorCode = 'unavailable' | 'unsupportedLanguage' | 'contextExceeded' | 'refused' | 'modelFailed'

export type ModelProcessMessage =
  | { type: 'response'; id: number; result: unknown }
  | { type: 'response'; id: number; error: { code: ModelErrorCode; message: string } }
  | ({ type: 'progress' } & ModelProgress)

export interface ModelProcessHandlers {
  message(message: ModelProcessMessage): void
  /** The process is gone; `reason` is null when it exited because `stop` closed its input. */
  exit(reason: string | null): void
}

export interface ModelProcessConnection {
  send(request: ModelRequest): void
  /** Closes the process's input, which makes it exit. */
  stop(): void
}

/** Starts the model process. Swapped for a fake in tests. */
export interface ModelProcessTransport {
  start(handlers: ModelProcessHandlers): ModelProcessConnection
}

/**
 * Runs the model process executable at `path`, speaking newline-delimited JSON over its stdio.
 * `requestSpeechAuthorization` must only be set when the app's Info.plist has a Speech Recognition
 * usage description; macOS kills the process if it asks without one. `modelsDir` holds downloaded models.
 */
export function spawnTransport(
  path: string,
  { requestSpeechAuthorization, modelsDir }: { requestSpeechAuthorization: boolean; modelsDir: string },
): ModelProcessTransport {
  const args = ['--models-dir', modelsDir, ...(requestSpeechAuthorization ? ['--request-speech-authorization'] : [])]
  return {
    start(handlers) {
      const child = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let stopping = false
      let exited = false
      const exit = (reason: string | null) => {
        if (exited) return
        exited = true
        handlers.exit(stopping ? null : reason)
      }
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          handlers.message(JSON.parse(line) as ModelProcessMessage)
        } catch {
          console.warn('[models] unparseable line', line)
        }
      })
      child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
      child.stdin.on('error', () => undefined)
      child.on('error', (error) => exit(error.message))
      child.on('exit', (code, signal) => exit(signal ? `killed by ${signal}` : `exit code ${code}`))
      return {
        send: (request) => child.stdin.write(`${JSON.stringify(request)}\n`),
        stop: () => {
          stopping = true
          child.stdin.end()
        },
      }
    },
  }
}

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message)
  }
}

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }

const IDLE_EXIT_MS = 10 * 60_000

/**
 * One model process, started on the first request. It exits after 10 minutes without requests, which
 * frees its models, and the next request starts it again.
 */
export class ModelProcess {
  private connection: ModelProcessConnection | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly transport: ModelProcessTransport,
    private readonly onProgress: (progress: ModelProgress) => void,
  ) {}

  request<K extends ModelRequestBody['type']>(body: Extract<ModelRequestBody, { type: K }>): Promise<ModelResults[K]> {
    const connection = this.connection ?? this.connect()
    const id = this.nextId++
    this.clearIdleTimer()
    return new Promise<ModelResults[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
      connection.send({ ...body, id })
    })
  }

  get running(): boolean {
    return this.connection !== null
  }

  stop(): void {
    this.clearIdleTimer()
    const connection = this.connection
    this.connection = null
    connection?.stop()
    const error = new ModelError('modelFailed', 'The model process was stopped')
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }

  private connect(): ModelProcessConnection {
    const connection: ModelProcessConnection = this.transport.start({
      message: (message) => {
        if (this.connection === connection) this.onMessage(message)
      },
      exit: (reason) => {
        if (this.connection !== connection) return
        this.connection = null
        this.clearIdleTimer()
        const error = new ModelError('modelFailed', `The model process stopped unexpectedly (${reason ?? 'exited'})`)
        for (const { reject } of this.pending.values()) reject(error)
        this.pending.clear()
      },
    })
    this.connection = connection
    return connection
  }

  private onMessage(message: ModelProcessMessage): void {
    switch (message.type) {
      case 'response': {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if ('error' in message) entry.reject(new ModelError(message.error.code, message.error.message))
        else entry.resolve(message.result)
        if (this.pending.size === 0) this.startIdleTimer()
        return
      }
      case 'progress': {
        const { type: _type, ...progress } = message
        this.onProgress(progress)
        return
      }
      default: {
        const unreachable: never = message
        console.warn('[models] unknown message', unreachable)
      }
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => this.stop(), IDLE_EXIT_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
