import type { ModelEntry, ModelSource, ModelTask, RepoCheck, RepoRejection, SpeedTier } from '../shared/modelLibrary'
import { HubError, listRepoFiles, readRepoFile, repoInfo, type HubFile, type RepoInfo } from './huggingFace'
import type { Fetch } from './providers'
import { PARAKEET_LANGUAGES, RECOMMENDED_MODELS, WHISPER_TOKENIZER } from './recommendedModels'

/** `model_type`s that mlx-swift-lm 3.32.3 registers; keep in step with the version in `native/models/Package.swift`. */
const MLX_LLM_TYPES = new Set(
  (
    'mistral mixtral llama phi phi3 phimoe gemma gemma2 gemma3 gemma3_text gemma3n gemma4 gemma4_unified gemma4_text ' +
    'qwen2 qwen3 qwen3_moe qwen3_next qwen3_5 qwen3_5_moe qwen3_5_text nanbeige minicpm starcoder2 cohere openelm ' +
    'internlm2 deepseek_v2 deepseek_v3 granite helium granitemoehybrid mimo mimo_v2_flash minimax glm4 glm4_moe ' +
    'glm4_moe_lite acereason falcon_h1 bitnet smollm3 ernie4_5 lfm2 baichuan_m1 exaone4 gpt_oss lille-130m olmoe ' +
    'olmo2 olmo3 bailing_moe lfm2_moe nanochat nemotron_h afmoe jamba mamba2 mistral3 apertus hunyuan_v1_dense ' +
    'nemotron_labs_diffusion'
  ).split(' '),
)
const MLX_VLM_TYPES = new Set(
  (
    'paligemma qwen2_vl qwen2_5_vl qwen3_vl qwen3_vl_moe qwen3_5 qwen3_5_moe idefics3 gemma3 gemma4 gemma4_unified ' +
    'smolvlm fastvlm llava_qwen2 pixtral mistral3 lfm2_vl lfm2-vl glm_ocr muse_glimmer'
  ).split(' '),
)

/** Top-level files an MLX model folder may need: configs, weights, tokenizer and chat template. */
const MLX_FILE = /\.(json|safetensors|jinja|txt|model|tiktoken)$/
/** Measured: MLX 4-bit models peak at about 1.3× their weights for short prompts. */
const MLX_MEMORY_FACTOR = 1.3
const WHISPERKIT_MODELS = ['AudioEncoder', 'MelSpectrogram', 'TextDecoder']
/** FluidAudio's `loadLocal(version: .v3)` reads exactly these. */
const PARAKEET_MODELS = ['Preprocessor', 'Encoder', 'Decoder', 'JointDecisionv3']
const PARAKEET_VOCAB = 'parakeet_vocab.json'
const WHISPER_SIZES: Record<number, string> = { 384: 'tiny', 512: 'base', 768: 'small', 1024: 'medium', 1280: 'large' }
const WHISPER_ENGLISH_VOCAB = 51864
const WHISPER_MULTILINGUAL_VOCAB = 51865
const WHISPER_V3_VOCAB = 51866
/** Measured on the Recommended Core ML models: about 1.7× their download while loaded. */
const CORE_ML_MEMORY_FACTOR = 1.7

/** swift-transformers loads a tokenizer from these two files only. */
const MLX_TOKENIZER = ['tokenizer.json', 'tokenizer_config.json']
const FIND_MLX = 'Look for an MLX version, often from mlx-community'

export interface RepoReference {
  repo: string
  revision?: string
  folder?: string
}

class Rejected extends Error {
  constructor(
    readonly reason: RepoRejection,
    message: string,
  ) {
    super(message)
  }
}

/** Accepts `org/name` or a huggingface.co URL, including `/tree/<rev>/<folder>` and `/blob/<rev>/<file>` links. */
export function parseRepoReference(input: string): RepoReference | null {
  const trimmed = input.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
  const path = trimmed.replace(/^(https?:\/\/)?(www\.)?(huggingface\.co|hf\.co)\//i, '')
  const match = path.match(/^([\w.-]+\/[\w.-]+)(?:\/(tree|blob|resolve)\/([^/]+)(?:\/(.+))?)?$/)
  if (!match || /^(datasets|spaces)\//.test(match[1])) return null
  const [, repo, kind, revision, rest] = match
  const folder = kind === 'tree' ? rest : rest?.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : undefined
  return { repo, ...(revision && { revision }), ...(folder && { folder: decodeURIComponent(folder) }) }
}

/** Whether OpenWispr can run the model in a pasted repo, and the entry to download it with if so. */
export async function checkHubRepo(fetch: Fetch, input: string): Promise<RepoCheck> {
  const ref = parseRepoReference(input)
  if (!ref) {
    return {
      kind: 'rejected',
      reason: 'invalidReference',
      message: 'Paste a Hugging Face model id like mlx-community/Qwen3-4B-Instruct-2507-4bit, or its URL',
    }
  }
  try {
    const info = await repoInfo(fetch, ref.repo, ref.revision)
    if (info.gated) {
      throw new Rejected(
        'gated',
        `${ref.repo} is gated: its owner approves each download, and OpenWispr downloads without a Hugging Face account`,
      )
    }
    const listed = await listRepoFiles(fetch, { repo: ref.repo, revision: info.sha, folder: ref.folder })
    const check = await classify(fetch, { ...ref, revision: info.sha }, info, listed)
    if (check.kind === 'compatible') {
      const [{ repo, folder }] = check.model.sources
      const listedAs = RECOMMENDED_MODELS.find((m) => m.sources[0].repo === repo && m.sources[0].folder === folder)
      if (listedAs) {
        throw new Rejected('alreadyListed', `${label({ repo, folder })} is already in Recommended models as ${listedAs.name}`)
      }
    }
    return check
  } catch (error) {
    const rejected = asRejection(error)
    return { kind: 'rejected', reason: rejected.reason, message: rejected.message }
  }
}

function asRejection(error: unknown): Rejected {
  if (error instanceof Rejected) return error
  if (error instanceof HubError) {
    switch (error.code) {
      case 'GatedRepo':
        return new Rejected('gated', error.message)
      case 'RevisionNotFound':
        return new Rejected('notFoundOrPrivate', error.message)
      case 'EntryNotFound':
        return new Rejected('missingFiles', error.message)
    }
    if (error.status === 401) {
      return new Rejected('notFoundOrPrivate', `${error.message}. Check the spelling; private repos can't be downloaded`)
    }
    return new Rejected('hubFailed', error.message)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new Rejected('hubFailed', `Couldn't check the repo on Hugging Face: ${message}`)
}

interface Pinned extends RepoReference {
  revision: string
}

/** A listed file with its path relative to the model's folder. */
interface Listed extends HubFile {
  rel: string
}

async function classify(fetch: Fetch, ref: Pinned, info: RepoInfo, listed: HubFile[]): Promise<RepoCheck> {
  const prefix = ref.folder ? `${ref.folder}/` : ''
  const files: Listed[] = listed
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, rel: file.path.slice(prefix.length) }))
  const dirs = new Set(files.filter((f) => f.rel.includes('/')).map((f) => f.rel.split('/')[0]))
  if (WHISPERKIT_MODELS.some((m) => dirs.has(`${m}.mlmodelc`))) return whisperKit(fetch, ref, files)
  if (PARAKEET_MODELS.some((m) => dirs.has(`${m}.mlmodelc`)) || files.some((f) => f.rel === PARAKEET_VOCAB)) {
    return fluidAudio(ref, files)
  }
  if (files.some((f) => !f.rel.includes('/') && f.rel.endsWith('.safetensors'))) return mlx(fetch, ref, info, files)
  if (!ref.folder) {
    const folders = speechFolders(files)
    if (folders.length === 1) return classify(fetch, { ...ref, folder: folders[0] }, info, listed)
    if (folders.length > 1) {
      return {
        kind: 'severalModels',
        repo: ref.repo,
        revision: ref.revision,
        folders,
        message: `${ref.repo} holds ${folders.length} speech-to-text models. Choose one`,
      }
    }
  }
  if (files.some((f) => f.rel.endsWith('.gguf'))) {
    throw new Rejected(
      'ggufOnly',
      `${label(ref)} only has GGUF weights, which are for llama.cpp. OpenWispr runs chat models with MLX: look for an MLX version, often from mlx-community`,
    )
  }
  throw new Rejected('missingFiles', `${label(ref)} has no MLX weights (.safetensors)`)
}

/** Folders below the repo root that hold a WhisperKit or FluidAudio model. */
function speechFolders(files: Listed[]): string[] {
  const marker = new RegExp(`^(.+)/(${[...WHISPERKIT_MODELS, ...PARAKEET_MODELS].join('|')})\\.mlmodelc/`)
  return [...new Set(files.map((f) => f.rel.match(marker)?.[1]).filter((folder) => folder !== undefined))].sort()
}

async function whisperKit(fetch: Fetch, ref: Pinned, files: Listed[]): Promise<RepoCheck> {
  const has = (rel: string) => files.some((f) => f.rel === rel)
  const missing = [
    ...WHISPERKIT_MODELS.map((m) => `${m}.mlmodelc`).filter((dir) => !has(`${dir}/coremldata.bin`)),
    ...['config.json'].filter((rel) => !has(rel)),
  ]
  if (missing.length > 0) throw missingFiles(ref, missing, 'WhisperKit needs')
  const config = JSON.parse(
    await readRepoFile(fetch, { repo: ref.repo, revision: ref.revision, path: path(ref, 'config.json') }),
  ) as WhisperConfig
  const tokenizerRepo = whisperTokenizerRepo(config)
  if (tokenizerRepo === null) {
    throw new Rejected('unsupportedArchitecture', `${label(ref)} has a config.json that isn't one of the Whisper models WhisperKit runs`)
  }
  const picked = files.filter((f) => /^[^/]+\.mlmodelc\//.test(f.rel) || /^[^/]+\.json$/.test(f.rel))
  const pickedPaths = [
    ...new Set(picked.map((f) => (f.rel.includes('/') ? path(ref, `${f.rel.split('/')[0]}/`) : f.path))),
  ].sort()
  const sources = [source(ref, pickedPaths)]
  let sizeBytes = sum(picked)
  if (!WHISPER_TOKENIZER.every(has)) {
    const tokenizer = await repoInfo(fetch, tokenizerRepo)
    const listed = await listRepoFiles(fetch, { repo: tokenizerRepo, revision: tokenizer.sha })
    const tokenizerFiles = listed.filter((f) => WHISPER_TOKENIZER.includes(f.path))
    const absent = WHISPER_TOKENIZER.filter((rel) => !tokenizerFiles.some((f) => f.path === rel))
    if (absent.length > 0) throw missingFiles({ repo: tokenizerRepo }, absent, 'WhisperKit needs')
    sources.push({ repo: tokenizerRepo, revision: tokenizer.sha, files: WHISPER_TOKENIZER })
    sizeBytes += sum(tokenizerFiles)
  }
  const english = config.vocab_size === WHISPER_ENGLISH_VOCAB
  return {
    kind: 'compatible',
    summary: `WhisperKit (Core ML), tokenizer from ${tokenizerRepo}`,
    model: {
      ...identity(ref),
      task: 'speechToText',
      engine: 'whisperKit',
      sources,
      sizeBytes,
      memoryBytes: Math.round(sizeBytes * CORE_ML_MEMORY_FACTOR),
      speed: whisperSpeed(sizeBytes),
      languages: english ? 'English' : '99 languages',
      languageCodes: english ? ['en'] : null,
    },
  }
}

interface WhisperConfig {
  _name_or_path?: string
  vocab_size?: number
  d_model?: number
}

/**
 * WhisperKit folders ship without a tokenizer, so it comes from OpenAI's repo for the same model: the one
 * the config names, else the one its vocabulary (large-v3 added a token, English-only models lack one)
 * and width identify.
 */
function whisperTokenizerRepo(config: WhisperConfig): string | null {
  const named = config._name_or_path?.match(/^openai\/whisper-[\w.-]+$/)?.[0]
  if (named) return named
  if (config.vocab_size === WHISPER_V3_VOCAB) return 'openai/whisper-large-v3'
  const size = WHISPER_SIZES[config.d_model ?? 0]
  if (size === undefined) return null
  if (config.vocab_size === WHISPER_MULTILINGUAL_VOCAB) return `openai/whisper-${size === 'large' ? 'large-v2' : size}`
  if (config.vocab_size === WHISPER_ENGLISH_VOCAB && size !== 'large') return `openai/whisper-${size}.en`
  return null
}

function whisperSpeed(sizeBytes: number): SpeedTier {
  if (sizeBytes < 150e6) return 'fastest'
  if (sizeBytes < 400e6) return 'fast'
  if (sizeBytes < 1.2e9) return 'medium'
  return 'slow'
}

function fluidAudio(ref: Pinned, files: Listed[]): RepoCheck {
  const dirs = PARAKEET_MODELS.map((m) => `${m}.mlmodelc`)
  const missing = [
    ...dirs.filter((dir) => !files.some((f) => f.rel === `${dir}/coremldata.bin`)),
    ...[PARAKEET_VOCAB].filter((rel) => !files.some((f) => f.rel === rel)),
  ]
  if (missing.length > 0) throw missingFiles(ref, missing, 'Parakeet TDT v3 needs')
  const picked = files.filter((f) => f.rel === PARAKEET_VOCAB || dirs.some((dir) => f.rel.startsWith(`${dir}/`)))
  const sizeBytes = sum(picked)
  return {
    kind: 'compatible',
    summary: 'Parakeet TDT v3 (FluidAudio, Core ML)',
    model: {
      ...identity(ref),
      task: 'speechToText',
      engine: 'fluidAudio',
      sources: [source(ref, [...dirs.map((dir) => path(ref, `${dir}/`)), path(ref, PARAKEET_VOCAB)].sort())],
      sizeBytes,
      memoryBytes: Math.round(sizeBytes * CORE_ML_MEMORY_FACTOR),
      speed: 'fastest',
      languages: '25 European languages',
      languageCodes: PARAKEET_LANGUAGES,
    },
  }
}

async function mlx(fetch: Fetch, ref: Pinned, info: RepoInfo, files: Listed[]): Promise<RepoCheck> {
  const top = files.filter((f) => !f.rel.includes('/'))
  const has = (rel: string) => top.some((f) => f.rel === rel)
  const read = (rel: string) => readRepoFile(fetch, { repo: ref.repo, revision: ref.revision, path: path(ref, rel) })
  if (!has('config.json')) throw missingFiles(ref, ['config.json'], 'MLX models need')
  const config = JSON.parse(await read('config.json')) as MlxConfig
  const bits = mlxBits(ref, config)
  const modelType = config.model_type ?? ''
  const task = mlxTask(modelType)
  if (task === null) {
    throw new Rejected(
      'unsupportedArchitecture',
      `${label(ref)} uses the ${modelType || 'unnamed'} architecture, which OpenWispr's MLX engine doesn't support yet`,
    )
  }
  const missing = [...MLX_TOKENIZER, ...missingShards(top)].filter((rel) => !has(rel))
  if (missing.length > 0) throw missingFiles(ref, missing, 'MLX models need')
  const picked = top.filter((f) => MLX_FILE.test(f.rel))
  const weightBytes = sum(picked.filter((f) => f.rel.endsWith('.safetensors')))
  const template = await read(picked.some((f) => f.rel === 'chat_template.jinja') ? 'chat_template.jinja' : 'tokenizer_config.json')
  const thinks = task === 'chat' && template.includes('enable_thinking')
  return {
    kind: 'compatible',
    summary: `MLX ${modelType}, ${bits}-bit`,
    model: {
      ...identity(ref),
      task,
      engine: 'mlx',
      sources: [source(ref, picked.map((f) => f.path).sort())],
      sizeBytes: sum(picked),
      memoryBytes: Math.round(weightBytes * MLX_MEMORY_FACTOR),
      speed: mlxSpeed(weightBytes),
      ...languages(info),
      ...(thinks && { chatTemplateContext: { enable_thinking: false } }),
    },
  }
}

interface MlxConfig {
  model_type?: string
  quantization?: { bits?: number; group_size?: number }
  quantization_config?: { bits?: number; group_size?: number; quant_method?: string }
}

/**
 * mlx-lm writes `quantization` (newer versions also copy it to `quantization_config`); a
 * `quantization_config` with a `quant_method` is a Transformers format such as GPTQ or AWQ instead.
 */
function mlxBits(ref: Pinned, config: MlxConfig): number {
  const foreign = config.quantization_config?.quant_method
  if (foreign && !config.quantization) {
    throw new Rejected('notMlx', `${label(ref)} is quantized with ${foreign}, which MLX can't load. ${FIND_MLX}`)
  }
  const quantization = config.quantization ?? config.quantization_config
  if (typeof quantization?.bits !== 'number' || typeof quantization.group_size !== 'number') {
    throw new Rejected(
      'notMlx',
      `${label(ref)} has no MLX quantization config, so its weights aren't quantized for MLX. Look for a 4-bit MLX version, often from mlx-community`,
    )
  }
  return quantization.bits
}

/** Sharded weights are named `model-0000i-of-0000n.safetensors`; every shard must be there. */
function missingShards(top: Listed[]): string[] {
  const shard = top.map((f) => f.rel.match(/^(.*)-(\d+)-of-(\d+)\.safetensors$/)).find((m) => m !== null)
  if (!shard) return []
  const [, stem, index, count] = shard
  return Array.from({ length: Number(count) }, (_, i) => `${stem}-${String(i + 1).padStart(index.length, '0')}-of-${count}.safetensors`)
}

/** Types in both registries, like `qwen3_5`, are chat models with a vision tower the chat engine skips. */
function mlxTask(modelType: string): ModelTask | null {
  if (MLX_LLM_TYPES.has(modelType)) return 'chat'
  if (MLX_VLM_TYPES.has(modelType)) return 'vision'
  return null
}

function mlxSpeed(weightBytes: number): SpeedTier {
  if (weightBytes < 1e9) return 'fastest'
  if (weightBytes < 3.5e9) return 'fast'
  if (weightBytes < 8e9) return 'medium'
  return 'slow'
}

function missingFiles(ref: RepoReference, missing: string[], needs: string): Rejected {
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`
  return new Rejected('missingFiles', `${label(ref)} is missing ${list}, which ${needs}`)
}

function identity(ref: Pinned): Pick<ModelEntry, 'id' | 'name'> {
  const id = `hf-${[ref.repo, ...(ref.folder ? [ref.folder] : [])].join('/').replaceAll('/', '--').replace(/[^\w.-]/g, '-')}`
  return { id, name: ref.folder?.split('/').pop() ?? ref.repo.split('/')[1] }
}

function languages(info: RepoInfo): Pick<ModelEntry, 'languages' | 'languageCodes'> {
  const count = info.languages.length
  return { languages: count === 0 ? 'Languages not listed' : `${count} language${count === 1 ? '' : 's'}`, languageCodes: null }
}

function source(ref: Pinned, files: string[]): ModelSource {
  return { repo: ref.repo, revision: ref.revision, ...(ref.folder && { folder: ref.folder }), files }
}

function path(ref: Pinned, rel: string): string {
  return ref.folder ? `${ref.folder}/${rel}` : rel
}

function label(ref: RepoReference): string {
  return ref.folder ? `${ref.repo}/${ref.folder}` : ref.repo
}

function sum(files: HubFile[]): number {
  return files.reduce((total, file) => total + file.size, 0)
}
