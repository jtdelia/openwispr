import { EventEmitter } from 'node:events'
import { totalmem } from 'node:os'
import {
  isLocalEndpoint,
  type BuiltInStatus,
  type EndpointConfig,
  type EndpointTestResult,
  type ModelProgress,
  type ModelRole,
  type Settings,
} from '../shared/types'
import type { ModelEntry, ModelLibrary, ModelStatus } from '../shared/modelLibrary'
import { ModelDownloads } from './modelDownloads'
import { ModelError, ModelProcess, type ModelProcessTransport, type TranscribeResult } from './modelProcess'
import { RECOMMENDED_MODELS } from './recommendedModels'
import {
  complete,
  parseSegments,
  transcribe,
  transcribeSegments,
  type ChatMessage,
  type Fetch,
  type KnownSpeakers,
  type TranscriptSegment,
} from './providers'

export type { ChatMessage, KnownSpeakers, TranscriptSegment }

export type ModelSettings = Pick<Settings, 'speechToText' | 'chat' | 'language'>

export type Availability = { available: true } | { available: false; reason: string }

export interface ModelsDeps {
  fetch: Fetch
  /** Current settings with decrypted API keys. */
  settings: () => ModelSettings
  /** Starts the model process that runs Built-in models. */
  transport: ModelProcessTransport
  /** Where downloaded Built-in models live, one folder per model. */
  modelsDir: string
  /** Defaults to this Mac's. */
  physicalMemoryBytes?: number
  /** Delay before retrying a dropped download; defaults to 2 s, doubling per attempt. */
  retryDelayMs?: number
}

const APPLE = 'apple'
const BUILT_IN_UNAVAILABLE = 'Built-in models are not available yet'
const TEST_TIMEOUT_MS = 20_000
/** A model needing more than this share of physical memory would likely make the Mac swap. */
const MEMORY_SHARE = 0.6

/** 16 kHz mono PCM16 silence. */
function silentWav(durationMs: number): Buffer {
  const dataBytes = Math.round((16_000 * durationMs) / 1000) * 2
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16_000, 24)
  wav.writeUInt32LE(32_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataBytes, 40)
  return wav
}

/** The only way Dictation and the Notetaker reach a speech-to-text or chat model. */
export class Models extends EventEmitter<{ progress: [ModelProgress] }> {
  private readonly process: ModelProcess
  private readonly libraryListeners = new Set<() => void>()
  private readonly downloads: ModelDownloads

  constructor(private readonly deps: ModelsDeps) {
    super()
    this.process = new ModelProcess(deps.transport, (progress) => this.emit('progress', progress))
    this.downloads = new ModelDownloads({
      fetch: deps.fetch,
      dir: deps.modelsDir,
      retryDelayMs: deps.retryDelayMs ?? 2000,
      onChange: () => this.libraryListeners.forEach((listener) => listener()),
    })
  }

  /** Recommended models and the ones the user added, with their download state and disk usage. */
  async library(): Promise<ModelLibrary> {
    const physicalMemoryBytes = this.deps.physicalMemoryBytes ?? totalmem()
    const status = async (model: ModelEntry, userAdded: boolean): Promise<ModelStatus> => ({
      model,
      recommended: !userAdded,
      userAdded,
      oversized: model.memoryBytes > physicalMemoryBytes * MEMORY_SHARE,
      state: await this.downloads.state(model.id),
    })
    const added = (await this.downloads.manifests()).filter((manifest) => manifest.userAdded)
    return {
      models: await Promise.all([
        ...RECOMMENDED_MODELS.map((model) => status(model, false)),
        ...added.map(({ userAdded, installed, files, ...model }) => status(model, userAdded)),
      ]),
      diskUsageBytes: await this.downloads.diskUsage(),
      physicalMemoryBytes,
    }
  }

  /** Called on every download state change and, while downloading, a few times a second. */
  onLibraryChanged(listener: () => void): () => void {
    this.libraryListeners.add(listener)
    return () => this.libraryListeners.delete(listener)
  }

  /** Downloads or resumes a Recommended model; resolves once installed or cancelled. */
  download(id: string): Promise<void> {
    const model = RECOMMENDED_MODELS.find((m) => m.id === id)
    if (!model) return Promise.reject(new Error(`Unknown model ${id}`))
    return this.downloads.start(model, { userAdded: false })
  }

  /** Stops a download and discards what it fetched. */
  cancelDownload(id: string): Promise<void> {
    return this.downloads.cancel(id)
  }

  /** Deletes a downloaded model; returns the bytes freed. */
  removeModel(id: string): Promise<number> {
    return this.downloads.remove(id)
  }

  /**
   * Whether `role` can be used right now. A chat Endpoint needs no key, since local servers don't ask
   * for one; a cloud speech-to-text Endpoint does, so a fresh install asks for one before recording.
   */
  availability(role: ModelRole): Availability {
    const config = this.resolve(role)
    if (config === null) {
      return role === 'speechToText' && this.builtInSpeechModel() !== null
        ? { available: true }
        : { available: false, reason: BUILT_IN_UNAVAILABLE }
    }
    switch (role) {
      case 'speechToText':
        if (!config.baseUrl.trim() || !config.model.trim()) {
          return { available: false, reason: 'Set up a speech-to-text model in Settings' }
        }
        if (!config.apiKey && !isLocalEndpoint(config.baseUrl)) {
          return { available: false, reason: 'Add a transcription API key in Settings' }
        }
        return { available: true }
      case 'chat':
        if (!config.baseUrl.trim() || !config.model.trim()) {
          return { available: false, reason: 'Set up a chat model in Settings' }
        }
        return { available: true }
      default: {
        const unreachable: never = role
        throw new Error(`unhandled model role ${String(unreachable)}`)
      }
    }
  }

  async transcribe(wav: Buffer, { prompt }: { prompt: string }): Promise<string> {
    const model = this.builtInSpeechModel()
    if (model !== null) return (await this.transcribeBuiltIn(model, wav, prompt, false)).text.trim()
    const { language } = this.deps.settings()
    return transcribe(this.deps.fetch, { ...this.endpoint('speechToText'), language }, wav, prompt)
  }

  /** A dictation has started: have the selected Built-in models loaded by the time its audio arrives. */
  warmUp(): void {
    const { language } = this.deps.settings()
    const model = this.builtInSpeechModel()
    if (model === null) return
    this.process
      .request({ type: 'load', models: [{ role: 'speechToText', id: model, language }] })
      .catch((error: unknown) => console.warn('[models] warm-up failed', error))
  }

  /** Like `transcribe`, but keeps segment timing and, for diarizing Endpoints, speaker labels. */
  async transcribeSegments(
    wav: Buffer,
    { durationMs, prompt, known }: { durationMs: number; prompt: string; known?: KnownSpeakers },
  ): Promise<TranscriptSegment[]> {
    const model = this.builtInSpeechModel()
    if (model !== null) return parseSegments(await this.transcribeBuiltIn(model, wav, prompt, true), durationMs)
    const { language } = this.deps.settings()
    return transcribeSegments(this.deps.fetch, { ...this.endpoint('speechToText'), language }, wav, durationMs, prompt, known)
  }

  /** Apple's models on this Mac, and whether they support the language setting. Starts the model process. */
  async status(): Promise<BuiltInStatus> {
    return this.process.request({ type: 'status', language: this.deps.settings().language })
  }

  /** Stops the model process; the next Built-in request starts it again. */
  stop(): void {
    this.process.stop()
  }

  async complete(messages: ChatMessage[], options: { label?: string; timeoutMs?: number } = {}): Promise<string> {
    return complete(this.deps.fetch, this.endpoint('chat'), messages, options)
  }

  /** Sends the selected Endpoint for `role` a tiny real request. */
  async testEndpoint(role: ModelRole): Promise<EndpointTestResult> {
    try {
      switch (role) {
        case 'speechToText':
          await transcribe(this.deps.fetch, { ...this.endpoint(role), language: '' }, silentWav(500), '')
          break
        case 'chat':
          await complete(this.deps.fetch, this.endpoint(role), [{ role: 'user', content: 'Reply with OK.' }], {
            label: 'Chat',
            timeoutMs: TEST_TIMEOUT_MS,
          })
          break
        default: {
          const unreachable: never = role
          throw new Error(`unhandled model role ${String(unreachable)}`)
        }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private endpoint(role: ModelRole): EndpointConfig {
    const config = this.resolve(role)
    if (config === null) throw new Error(BUILT_IN_UNAVAILABLE)
    return config
  }

  private async transcribeBuiltIn(model: string, wav: Buffer, prompt: string, segments: boolean): Promise<TranscribeResult> {
    const { language } = this.deps.settings()
    try {
      return await this.process.request({ type: 'transcribe', model, audio: wav.toString('base64'), language, prompt, segments })
    } catch (error) {
      if (error instanceof ModelError && error.code === 'unsupportedLanguage') {
        throw new ModelError(error.code, `${error.message}. Choose another language in Settings`)
      }
      throw error
    }
  }

  /** The Built-in speech-to-text model to use, or null when an Endpoint or a not-yet-supported model is selected. */
  private builtInSpeechModel(): string | null {
    const selection = this.deps.settings().speechToText
    return selection.kind === 'builtIn' && selection.modelId === APPLE ? APPLE : null
  }

  /** The Endpoint serving `role`, or null when a Built-in model is selected. */
  private resolve(role: ModelRole): EndpointConfig | null {
    const settings = this.deps.settings()
    const selection = settings[role]
    if (selection.kind !== 'endpoint') return null
    const other = settings[role === 'chat' ? 'speechToText' : 'chat']
    const sharedKey = other.kind === 'endpoint' && other.baseUrl === selection.baseUrl ? other.apiKey : ''
    return { baseUrl: selection.baseUrl, model: selection.model, apiKey: selection.apiKey || sharedKey }
  }
}
