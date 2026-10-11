import { EventEmitter } from 'node:events'
import { totalmem } from 'node:os'
import {
  isLocalEndpoint,
  MODEL_ROLES,
  type BuiltInStatus,
  type EndpointConfig,
  type EndpointTestResult,
  type ModelProgress,
  type ModelRole,
  type Settings,
} from '../shared/types'
import { isRunnable, type ModelEntry, type ModelLibrary, type ModelStatus } from '../shared/modelLibrary'
import { ModelDownloads, type ModelManifest } from './modelDownloads'
import { ModelError, ModelProcess, type ModelProcessTransport, type ModelRef, type TranscribeResult } from './modelProcess'
import { RECOMMENDED_MODELS } from './recommendedModels'
import { cleanupMaxTokens, cleanupMessages, sanitizeCleanup, type CleanupInput } from './textProcessing'
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

type BuiltInSelection = { model: string } | { unavailable: string }

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
const ROLE_NAMES: Record<ModelRole, string> = { speechToText: 'speech-to-text', chat: 'chat' }
const BUILT_IN_UNAVAILABLE = 'Built-in models are not available yet'
const TEST_TIMEOUT_MS = 20_000
const DEFAULT_MAX_TOKENS = 1024
/** Loads that take longer are compiling the model for this Mac, which the first use of a Core ML model does. */
const PREPARING_AFTER_MS = 1000
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

export interface CleanupResult {
  text: string
  /** Why Cleanup didn't run, for the Flow bar; null when it ran or the transcript was kept quietly. */
  notice: string | null
}

function cleanupNotice(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  if (!(error instanceof ModelError)) return `Cleanup failed: ${message}`
  switch (error.code) {
    case 'refused':
      return null
    case 'unavailable':
    case 'unsupportedLanguage':
    case 'contextExceeded':
      return `Cleanup skipped: ${message}`
    case 'modelFailed':
      return `Cleanup failed: ${message}`
    default: {
      const unreachable: never = error.code
      throw new Error(`unhandled model error ${String(unreachable)}`)
    }
  }
}

/** The only way Dictation and the Notetaker reach a speech-to-text or chat model. */
export class Models extends EventEmitter<{ progress: [ModelProgress] }> {
  private readonly process: ModelProcess
  private readonly libraryListeners = new Set<() => void>()
  private readonly downloads: ModelDownloads
  private installed = new Map<string, ModelManifest>()
  private readonly loads = new Map<string, Promise<void>>()
  private readonly preparing = new Set<string>()
  /** Resolves once the installed models have been read, which `availability` relies on. */
  readonly ready: Promise<void>

  constructor(private readonly deps: ModelsDeps) {
    super()
    this.process = new ModelProcess(deps.transport, (progress) => this.emit('progress', progress))
    this.downloads = new ModelDownloads({
      fetch: deps.fetch,
      dir: deps.modelsDir,
      retryDelayMs: deps.retryDelayMs ?? 2000,
      onChange: () => this.libraryChanged(),
    })
    this.ready = this.refreshInstalled()
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
      preparing: this.preparing.has(model.id),
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

  /**
   * Downloads or resumes a Recommended model; resolves once installed or cancelled. An installed
   * speech-to-text model is then loaded, so the slow first load doesn't land on its first dictation.
   */
  async download(id: string): Promise<void> {
    const model = RECOMMENDED_MODELS.find((m) => m.id === id)
    if (!model) throw new Error(`Unknown model ${id}`)
    await this.downloads.start(model, { userAdded: false })
    await this.refreshInstalled()
    const installed = this.installed.get(id)
    if (installed?.task === 'speechToText' && isRunnable(installed)) {
      this.prepare('speechToText', id).catch((error: unknown) => console.warn('[models] preparing a downloaded model failed', error))
    }
  }

  /** Stops a download and discards what it fetched. */
  async cancelDownload(id: string): Promise<void> {
    await this.downloads.cancel(id)
    await this.refreshInstalled()
  }

  /** Deletes a downloaded model; returns the bytes freed. The selected model of a role can't be removed. */
  async removeModel(id: string): Promise<number> {
    const settings = this.deps.settings()
    const role = MODEL_ROLES.find((r) => {
      const selection = settings[r]
      return selection.kind === 'builtIn' && selection.modelId === id
    })
    if (role) {
      const name = this.installed.get(id)?.name ?? id
      throw new Error(`${name} is selected for ${ROLE_NAMES[role]}. Choose another model in Settings before removing it`)
    }
    const freed = await this.downloads.remove(id)
    await this.refreshInstalled()
    return freed
  }

  /**
   * Whether `role` can be used right now. A chat Endpoint needs no key, since local servers don't ask
   * for one; a cloud speech-to-text Endpoint does, so a fresh install asks for one before recording.
   */
  availability(role: ModelRole): Availability {
    const config = this.resolve(role)
    if (config === null) {
      const builtIn = this.builtIn(role)
      return builtIn === null || 'model' in builtIn ? { available: true } : { available: false, reason: builtIn.unavailable }
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
    const speech = this.builtInSpeech()
    const speechModel = speech !== null && 'model' in speech ? speech.model : null
    if (speechModel !== null && speechModel !== APPLE) {
      this.prepare('speechToText', speechModel).catch((error: unknown) => console.warn('[models] warm-up failed', error))
    }
    const chat = this.builtInChatModel()
    if (chat !== null && chat !== APPLE) {
      this.prepare('chat', chat).catch((error: unknown) => console.warn('[models] warm-up failed', error))
    }
    const refs: ModelRef[] = [
      ...(speechModel === APPLE ? [{ role: 'speechToText' as const, id: APPLE, language }] : []),
      ...(chat === APPLE ? [{ role: 'chat' as const, id: APPLE, language }] : []),
    ]
    if (refs.length === 0) return
    this.process
      .request({ type: 'load', models: refs })
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

  /**
   * Apple's models on this Mac and, for a selected downloaded speech-to-text model, its languages; each
   * says whether it supports the language setting. Starts the model process.
   */
  async status(): Promise<BuiltInStatus> {
    const { language } = this.deps.settings()
    const speech = this.builtInSpeech()
    const model = speech !== null && 'model' in speech && speech.model !== APPLE ? speech.model : null
    const chat = this.builtInChatModel()
    return this.process.request({
      type: 'status',
      language,
      ...(model !== null && { speechToText: model }),
      ...(chat !== null && chat !== APPLE && { chat }),
    })
  }

  /** How many tokens a chat request and its answer may use together, or null when unknown, as for Endpoints. */
  async chatContextSize(): Promise<number | null> {
    const chat = this.builtInChatModel()
    if (chat === null) return null
    const status = await this.status()
    return chat === APPLE ? status.appleChat.contextSize : (status.chat?.contextSize ?? null)
  }

  /** Stops the model process; the next Built-in request starts it again. */
  stop(): void {
    this.process.stop()
  }

  /** `maxTokens` caps the answer of Built-in models, which fail rather than cut it off. */
  async complete(
    messages: ChatMessage[],
    { maxTokens = DEFAULT_MAX_TOKENS, ...options }: { label?: string; timeoutMs?: number; maxTokens?: number } = {},
  ): Promise<string> {
    const chat = this.builtIn('chat')
    if (chat === null) return complete(this.deps.fetch, this.endpoint('chat'), messages, options)
    if ('unavailable' in chat) throw new ModelError('unavailable', chat.unavailable)
    return (await this.process.request({ type: 'complete', model: chat.model, messages, maxTokens })).text.trim()
  }

  /**
   * Cleans up a Dictation's (dictionary-corrected) transcript. When the chat model is unavailable,
   * fails, refuses or answers instead of formatting, the transcript is kept as it is; `notice` says
   * why when the user should know.
   */
  async cleanup(input: CleanupInput): Promise<CleanupResult> {
    try {
      const output = await this.complete(cleanupMessages(input), {
        label: 'Chat',
        maxTokens: cleanupMaxTokens(input.transcript),
      })
      return { text: sanitizeCleanup(output, input.transcript), notice: null }
    } catch (error) {
      return { text: input.transcript, notice: cleanupNotice(error) }
    }
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
        const isWhisper = this.installed.get(model)?.engine === 'whisperKit'
        const hint = isWhisper ? 'Choose another language' : 'Download a Whisper model or choose another language'
        throw new ModelError(error.code, `${error.message}. ${hint} in Settings`)
      }
      throw error
    }
  }

  /** The Built-in speech-to-text model to use, or null when an Endpoint is selected; throws when it can't be used. */
  private builtInSpeechModel(): string | null {
    const speech = this.builtInSpeech()
    if (speech === null) return null
    if ('unavailable' in speech) throw new Error(speech.unavailable)
    return speech.model
  }

  private builtInSpeech(): BuiltInSelection | null {
    return this.builtIn('speechToText')
  }

  /** The selected Built-in model for `role`, or why it can't be used; null when an Endpoint is selected. */
  private builtIn(role: ModelRole): BuiltInSelection | null {
    const selection = this.deps.settings()[role]
    if (selection.kind !== 'builtIn') return null
    const id = selection.modelId
    if (id === APPLE) return { model: APPLE }
    const manifest = this.installed.get(id)
    const roleName = ROLE_NAMES[role]
    if (!manifest) {
      const name = RECOMMENDED_MODELS.find((m) => m.id === id)?.name ?? id
      return { unavailable: `${name} isn't downloaded. Download it or choose another ${roleName} model in Settings` }
    }
    if (manifest.task !== role) return { unavailable: `${manifest.name} isn't a ${roleName} model` }
    if (!isRunnable(manifest)) {
      return { unavailable: `${manifest.name} needs an engine OpenWispr doesn't have yet. Choose another ${roleName} model in Settings` }
    }
    return { model: id }
  }

  /** Loads a downloaded model in the model process, reporting it as preparing while a slow first load runs. */
  private prepare(role: ModelRole, id: string): Promise<void> {
    const running = this.loads.get(id)
    if (running) return running
    const name = this.installed.get(id)?.name ?? id
    const { language } = this.deps.settings()
    const timer = setTimeout(() => this.setPreparing(id, name, true), PREPARING_AFTER_MS)
    const load = this.process
      .request({ type: 'load', models: [{ role, id, language }] })
      .then(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        this.loads.delete(id)
        if (this.preparing.has(id)) this.setPreparing(id, name, false)
      })
    this.loads.set(id, load)
    return load
  }

  private setPreparing(modelId: string, name: string, preparing: boolean): void {
    if (preparing) this.preparing.add(modelId)
    else this.preparing.delete(modelId)
    this.emit('progress', { kind: 'preparingModel', modelId, name, preparing })
    this.libraryChanged()
  }

  private libraryChanged(): void {
    this.libraryListeners.forEach((listener) => listener())
  }

  private async refreshInstalled(): Promise<void> {
    const manifests = await this.downloads.manifests()
    this.installed = new Map(manifests.filter((m) => m.installed).map((m) => [m.id, m]))
  }

  /** The selected Built-in chat model when it can be used. */
  private builtInChatModel(): string | null {
    const chat = this.builtIn('chat')
    return chat !== null && 'model' in chat ? chat.model : null
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
