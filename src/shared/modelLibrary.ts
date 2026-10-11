import type { ModelRole } from './types'

/** Vision models are listed for Lens, which comes later. */
export type ModelTask = ModelRole | 'vision'

export const MODEL_TASKS: ModelTask[] = ['speechToText', 'chat', 'vision']

export type ModelEngine = 'whisperKit' | 'fluidAudio' | 'mlx'

/** Engines the model process can run, per task; installed models of other engines can't be selected yet. */
export const RUNNABLE_ENGINES: Record<ModelTask, ModelEngine[]> = {
  speechToText: ['whisperKit', 'fluidAudio'],
  chat: ['mlx'],
  vision: [],
}

export function isRunnable(model: Pick<ModelEntry, 'task' | 'engine'>): boolean {
  return RUNNABLE_ENGINES[model.task].includes(model.engine)
}

export type SpeedTier = 'fastest' | 'fast' | 'medium' | 'slow'

/**
 * Files to fetch from one Hugging Face repo at a pinned commit. With `folder`, only that folder is fetched
 * and its contents land at the model's root; with `files`, only those paths (a trailing `/` takes a whole
 * folder); with neither, the whole repo minus docs and images.
 */
export interface ModelSource {
  repo: string
  /** Commit sha. */
  revision: string
  folder?: string
  files?: string[]
}

/** A Built-in model OpenWispr can download: a Recommended model, or one the user added. */
export interface ModelEntry {
  id: string
  name: string
  task: ModelTask
  engine: ModelEngine
  /** More than one when an engine needs files from a second repo, like WhisperKit's tokenizer. */
  sources: ModelSource[]
  /** Approximate; the real total comes from the Hugging Face listing. */
  sizeBytes: number
  /** Rough resident memory while loaded. */
  memoryBytes: number
  speed: SpeedTier
  /** For display, like "99 languages". */
  languages: string
  /** ISO codes when the set is small and known; null for broadly multilingual models. */
  languageCodes: string[] | null
  /** Extra chat template variables the engine must pass, like `enable_thinking: false`. */
  chatTemplateContext?: Record<string, boolean>
}

export type DownloadState =
  | { kind: 'notDownloaded' }
  | { kind: 'downloading'; bytesDone: number; totalBytes: number; bytesPerSecond: number }
  /** Interrupted (quit, or retries ran out) with partial files kept, so it resumes where it stopped. */
  | { kind: 'paused'; bytesDone: number; totalBytes: number; error: string | null }
  | { kind: 'installed'; sizeBytes: number }

export interface ModelStatus {
  model: ModelEntry
  recommended: boolean
  userAdded: boolean
  /** Its memory estimate exceeds about 60% of this Mac's memory, so it would likely thrash. */
  oversized: boolean
  state: DownloadState
  /** Installed and loading for the first time, which compiles it for this Mac and can take minutes. */
  preparing: boolean
}

/**
 * Why a Hugging Face repo can't be added. Without an account, Hugging Face answers a private repo exactly
 * like a missing one, so the two share `notFoundOrPrivate`.
 */
export type RepoRejection =
  | 'invalidReference'
  | 'notFoundOrPrivate'
  | 'gated'
  | 'ggufOnly'
  | 'notMlx'
  | 'unsupportedArchitecture'
  | 'missingFiles'
  | 'alreadyListed'
  | 'hubFailed'

/** The compatibility check of a pasted repo id or URL, made before anything is downloaded. */
export type RepoCheck =
  /** `oversized` as in `ModelStatus`. */
  | { kind: 'compatible'; model: ModelEntry; summary: string; oversized: boolean }
  /** A repo holding several speech-to-text models, like WhisperKit's; one folder must be chosen. */
  | { kind: 'severalModels'; repo: string; revision: string; folders: string[]; message: string }
  | { kind: 'rejected'; reason: RepoRejection; message: string }

export interface ModelLibrary {
  models: ModelStatus[]
  /** Everything under the models folder, partial downloads included. */
  diskUsageBytes: number
  physicalMemoryBytes: number
}
