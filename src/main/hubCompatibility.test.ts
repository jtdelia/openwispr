import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeHub, json, text, type FakeHub, type FakeRepo, type FakeRepoInfo } from './fakeHub'
import type { ModelProcessTransport } from './modelProcess'
import { Models, type ModelSettings } from './models'

const SETTINGS: ModelSettings = {
  speechToText: { kind: 'builtIn', modelId: 'apple' },
  chat: { kind: 'builtIn', modelId: 'apple' },
  language: '',
}

const SHA = 'a'.repeat(40)
const WEIGHTS = Buffer.alloc(5000, 7)

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openwispr-hub-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const idleProcess: ModelProcessTransport = {
  start: (handlers) => ({
    send: (request) => queueMicrotask(() => handlers.message({ type: 'response', id: request.id, result: {} })),
    stop: () => queueMicrotask(() => handlers.exit(null)),
  }),
}

function models(hub: FakeHub, settings = SETTINGS) {
  return new Models({ fetch: hub.fetch, settings: () => settings, transport: idleProcess, modelsDir: dir, retryDelayMs: 0 })
}

function hub(repos: Record<string, FakeRepo>, info?: Record<string, FakeRepoInfo>) {
  return fakeHub(repos, undefined, info)
}

const mlxConfig = { model_type: 'qwen3_5', quantization: { group_size: 64, bits: 4 }, vision_config: {} }

const mlxRepo = (config: unknown = mlxConfig): FakeRepo => ({
  '.gitattributes': text('*.safetensors filter=lfs'),
  'README.md': text('# Qwen3.5'),
  'config.json': json(config),
  'model.safetensors': { content: WEIGHTS, lfs: true },
  'tokenizer.json': text('{"model":{}}'),
  'tokenizer_config.json': text('{}'),
  'chat_template.jinja': text('{%- if enable_thinking is false %}{%- endif %}'),
})

const downloadedPaths = (h: FakeHub) =>
  h.requests.filter((r) => r.url.includes('/resolve/')).map((r) => new URL(r.url).pathname.split('/').slice(5).join('/'))

describe('Rejecting repos OpenWispr can’t download or run', () => {
  it('rejects a GGUF-only repo, which is for llama.cpp', async () => {
    const h = hub({
      [`Qwen/Qwen3-4B-GGUF@${SHA}`]: {
        'README.md': text('# GGUF'),
        'Qwen3-4B-Q4_K_M.gguf': { content: WEIGHTS, lfs: true },
        'Qwen3-4B-Q8_0.gguf': { content: WEIGHTS, lfs: true },
      },
    })

    expect(await models(h).checkRepo('Qwen/Qwen3-4B-GGUF')).toEqual({
      kind: 'rejected',
      reason: 'ggufOnly',
      message:
        'Qwen/Qwen3-4B-GGUF only has GGUF weights, which are for llama.cpp. OpenWispr runs chat models with MLX: look for an MLX version, often from mlx-community',
    })
  })

  it('rejects a gated repo before downloading anything, since downloads are anonymous', async () => {
    const h = hub({ [`meta-llama/Llama-3.2-1B@${SHA}`]: mlxRepo() }, { 'meta-llama/Llama-3.2-1B': { gated: 'manual' } })

    expect(await models(h).checkRepo('https://huggingface.co/meta-llama/Llama-3.2-1B')).toEqual({
      kind: 'rejected',
      reason: 'gated',
      message:
        'meta-llama/Llama-3.2-1B is gated: its owner approves each download, and OpenWispr downloads without a Hugging Face account',
    })
    expect(downloadedPaths(h)).toEqual([])
  })

  it('reports a missing and a private repo with one reason, since Hugging Face answers both alike', async () => {
    expect(await models(hub({})).checkRepo('someone/not-a-model')).toEqual({
      kind: 'rejected',
      reason: 'notFoundOrPrivate',
      message: "someone/not-a-model was not found or is private. Check the spelling; private repos can't be downloaded",
    })
  })

  it('rejects a revision the repo does not have', async () => {
    const h = hub({ [`mlx-community/Qwen3.5-4B-4bit@${SHA}`]: mlxRepo() })

    expect(await models(h).checkRepo('https://huggingface.co/mlx-community/Qwen3.5-4B-4bit/tree/v9')).toEqual({
      kind: 'rejected',
      reason: 'notFoundOrPrivate',
      message: 'mlx-community/Qwen3.5-4B-4bit has no such revision',
    })
  })

  it('says so when Hugging Face can’t be reached, rather than blaming the repo', async () => {
    const offline = { fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as typeof fetch, requests: [] }

    expect(await models(offline).checkRepo('mlx-community/Qwen3.5-4B-4bit')).toEqual({
      kind: 'rejected',
      reason: 'hubFailed',
      message: "Couldn't check the repo on Hugging Face: fetch failed",
    })
  })

  it('points to the Recommended model when the repo is one', async () => {
    const h = hub({ [`mlx-community/Qwen3-4B-Instruct-2507-4bit@${SHA}`]: mlxRepo({ ...mlxConfig, model_type: 'qwen3' }) })

    expect(await models(h).checkRepo('mlx-community/Qwen3-4B-Instruct-2507-4bit')).toEqual({
      kind: 'rejected',
      reason: 'alreadyListed',
      message: 'mlx-community/Qwen3-4B-Instruct-2507-4bit is already in Recommended models as Qwen3 4B Instruct',
    })
  })

  it.each(['', 'not a repo', 'https://huggingface.co/datasets/someone/data', 'https://example.com/a/b'])(
    'asks for a model id when given %j',
    async (input) => {
      expect(await models(hub({})).checkRepo(input)).toMatchObject({ kind: 'rejected', reason: 'invalidReference' })
    },
  )
})

describe('Adding a compatible repo', () => {
  const REPO = 'mlx-community/Qwen3.5-4B-4bit'
  const ID = 'hf-mlx-community--Qwen3.5-4B-4bit'
  const info = { [REPO]: { cardData: { language: ['en', 'zh', 'fr'] } } }

  /** Sends the first 2000 bytes of the weights, then the network goes down for good. */
  const droppingHub = () => {
    let dropped = false
    return fakeHub({ [`${REPO}@${SHA}`]: mlxRepo() }, (path) => {
      if (path !== 'model.safetensors') return undefined
      if (dropped) throw new TypeError('fetch failed')
      dropped = true
      let sent = false
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) return controller.error(new TypeError('terminated'))
            sent = true
            controller.enqueue(new Uint8Array(WEIGHTS.subarray(0, 2000)))
          },
        }),
      )
    }, info)
  }

  it('downloads it like a Recommended model, resuming after a restart, then lists it as added by the user', async () => {
    const first = models(droppingHub())
    const check = await first.checkRepo(REPO)
    if (check.kind !== 'compatible') throw new Error(check.message)
    expect(check.model.languages).toBe('3 languages')

    await expect(first.addModel(check.model)).rejects.toThrow('fetch failed')

    const online = hub({ [`${REPO}@${SHA}`]: mlxRepo() }, info)
    const afterRestart = models(online)
    const paused = (await afterRestart.library()).models.find((s) => s.model.id === ID)
    expect(paused).toMatchObject({ userAdded: true, recommended: false, state: { kind: 'paused', bytesDone: 85 + 2000 } })

    await afterRestart.download(ID)

    expect(online.requests.filter((r) => r.url.endsWith('/model.safetensors')).map((r) => r.range)).toEqual(['bytes=2000-'])
    const library = await afterRestart.library()
    expect(library.models.find((s) => s.model.id === ID)).toMatchObject({
      userAdded: true,
      recommended: false,
      model: { name: 'Qwen3.5-4B-4bit', task: 'chat', engine: 'mlx', chatTemplateContext: { enable_thinking: false } },
      state: { kind: 'installed', sizeBytes: 5145 },
    })
    expect(library.models.filter((s) => s.recommended).length).toBeGreaterThan(0)
  })

  it('can be selected for its task, and removed once another model is selected', async () => {
    const settings: ModelSettings = { ...SETTINGS, chat: { kind: 'builtIn', modelId: ID } }
    const selecting = models(hub({ [`${REPO}@${SHA}`]: mlxRepo() }, info), settings)
    const check = await selecting.checkRepo(REPO)
    if (check.kind !== 'compatible') throw new Error(check.message)
    await selecting.addModel(check.model)

    expect(selecting.availability('chat')).toEqual({ available: true })
    await expect(selecting.removeModel(ID)).rejects.toThrow('Qwen3.5-4B-4bit is selected for chat')

    const other = models(hub({}))
    expect(await other.removeModel(ID)).toBeGreaterThan(5145)
    expect((await other.library()).models.some((s) => s.model.id === ID)).toBe(false)
  })
})

const TOKENIZER_SHA = 'b'.repeat(40)
const MLMODEL = 'program(1.0)'

/** A WhisperKit model folder: three Core ML models plus configs, without a tokenizer. */
const whisperFolder = (folder: string, config: unknown, skip: string[] = []): FakeRepo =>
  Object.fromEntries(
    Object.entries<FakeRepo[string]>({
      'AudioEncoder.mlmodelc/coremldata.bin': text(MLMODEL),
      'AudioEncoder.mlmodelc/weights/weight.bin': { content: WEIGHTS, lfs: true },
      'MelSpectrogram.mlmodelc/coremldata.bin': text(MLMODEL),
      'TextDecoder.mlmodelc/coremldata.bin': text(MLMODEL),
      'config.json': json(config),
      'generation_config.json': text('{}'),
    })
      .filter(([path]) => !skip.some((s) => path.startsWith(s)))
      .map(([path, file]) => [`${folder}/${path}`, file]),
  )

const whisperTokenizer = (): FakeRepo => ({
  'README.md': text('# Whisper'),
  'model.safetensors': { content: WEIGHTS, lfs: true },
  'tokenizer.json': text('{"model":{}}'),
  'tokenizer_config.json': text('{}'),
})

const WHISPER_SMALL_CONFIG = { _name_or_path: 'openai/whisper-small', vocab_size: 51865, d_model: 768 }

describe('Checking a WhisperKit repo', () => {
  it('accepts a WhisperKit folder, taking its tokenizer from the matching OpenAI repo', async () => {
    const h = hub({
      [`argmaxinc/whisperkit-coreml@${SHA}`]: {
        'README.md': text('# WhisperKit'),
        'config.json': text('{"device_support":[]}'),
        ...whisperFolder('openai_whisper-small', WHISPER_SMALL_CONFIG),
        ...whisperFolder('openai_whisper-tiny', { vocab_size: 51865, d_model: 384 }),
      },
      [`openai/whisper-small@${TOKENIZER_SHA}`]: whisperTokenizer(),
    })

    const check = await models(h).checkRepo('https://huggingface.co/argmaxinc/whisperkit-coreml/tree/main/openai_whisper-small')

    const configBytes = JSON.stringify(WHISPER_SMALL_CONFIG).length
    const sizeBytes = 3 * MLMODEL.length + 5000 + configBytes + 2 + 12 + 2
    expect(check).toEqual({
      kind: 'compatible',
      oversized: false,
      summary: 'WhisperKit (Core ML), tokenizer from openai/whisper-small',
      model: {
        id: 'hf-argmaxinc--whisperkit-coreml--openai_whisper-small',
        name: 'openai_whisper-small',
        task: 'speechToText',
        engine: 'whisperKit',
        sources: [
          {
            repo: 'argmaxinc/whisperkit-coreml',
            revision: SHA,
            folder: 'openai_whisper-small',
            files: [
              'openai_whisper-small/AudioEncoder.mlmodelc/',
              'openai_whisper-small/MelSpectrogram.mlmodelc/',
              'openai_whisper-small/TextDecoder.mlmodelc/',
              'openai_whisper-small/config.json',
              'openai_whisper-small/generation_config.json',
            ],
          },
          { repo: 'openai/whisper-small', revision: TOKENIZER_SHA, files: ['tokenizer.json', 'tokenizer_config.json'] },
        ],
        sizeBytes,
        memoryBytes: Math.round(sizeBytes * 1.7),
        speed: 'fastest',
        languages: '99 languages',
        languageCodes: null,
      },
    })
    expect(downloadedPaths(h)).toEqual(['openai_whisper-small/config.json'])
  })

  it('offers the model folders of a repo holding several, like WhisperKit’s', async () => {
    const h = hub({
      [`argmaxinc/whisperkit-coreml@${SHA}`]: {
        'config.json': text('{"device_support":[]}'),
        ...whisperFolder('openai_whisper-small_216MB', WHISPER_SMALL_CONFIG),
        ...whisperFolder('openai_whisper-tiny', { vocab_size: 51865, d_model: 384 }),
      },
    })

    expect(await models(h).checkRepo('argmaxinc/whisperkit-coreml')).toEqual({
      kind: 'severalModels',
      repo: 'argmaxinc/whisperkit-coreml',
      revision: SHA,
      folders: ['openai_whisper-small_216MB', 'openai_whisper-tiny'],
      message: 'argmaxinc/whisperkit-coreml holds 2 speech-to-text models. Choose one',
    })
  })

  it('recognizes an English-only Whisper from its vocabulary when its config names no OpenAI repo', async () => {
    const h = hub({
      [`someone/whisper-base-en-coreml@${SHA}`]: whisperFolder('base.en', { _name_or_path: './out', vocab_size: 51864, d_model: 512 }),
      [`openai/whisper-base.en@${TOKENIZER_SHA}`]: whisperTokenizer(),
    })

    const check = await models(h).checkRepo('someone/whisper-base-en-coreml/tree/main/base.en')

    expect(check).toMatchObject({
      kind: 'compatible',
      oversized: false,
      summary: 'WhisperKit (Core ML), tokenizer from openai/whisper-base.en',
      model: { languages: 'English', languageCodes: ['en'] },
    })
  })

  it('rejects a WhisperKit folder missing one of its Core ML models', async () => {
    const h = hub({
      [`argmaxinc/whisperkit-coreml@${SHA}`]: whisperFolder('openai_whisper-small_216MB', WHISPER_SMALL_CONFIG, ['TextDecoder']),
    })

    expect(await models(h).checkRepo('argmaxinc/whisperkit-coreml/tree/main/openai_whisper-small_216MB')).toEqual({
      kind: 'rejected',
      reason: 'missingFiles',
      message: 'argmaxinc/whisperkit-coreml/openai_whisper-small_216MB is missing TextDecoder.mlmodelc, which WhisperKit needs',
    })
  })
})

const parakeetRepo = (joint = 'JointDecisionv3'): FakeRepo => ({
  'README.md': text('# Parakeet'),
  'config.json': text('{}'),
  'Preprocessor.mlmodelc/coremldata.bin': text(MLMODEL),
  'Encoder.mlmodelc/coremldata.bin': text(MLMODEL),
  'Encoder.mlmodelc/weights/weight.bin': { content: WEIGHTS, lfs: true },
  'Encoder_v2.mlmodelc/coremldata.bin': text(MLMODEL),
  'Decoder.mlmodelc/coremldata.bin': text(MLMODEL),
  [`${joint}.mlmodelc/coremldata.bin`]: text(MLMODEL),
  'parakeet_vocab.json': text('{"0":"<unk>"}'),
})

describe('Checking a FluidAudio repo', () => {
  it('accepts the Parakeet TDT v3 layout FluidAudio loads, fetching only the files it reads', async () => {
    const h = hub(
      { [`someone/parakeet-tdt-0.6b-v3-coreml@${SHA}`]: parakeetRepo() },
      { 'someone/parakeet-tdt-0.6b-v3-coreml': { cardData: { language: ['en', 'de', 'fr'] } } },
    )

    const check = await models(h).checkRepo('someone/parakeet-tdt-0.6b-v3-coreml')

    const sizeBytes = 4 * MLMODEL.length + 5000 + 13
    expect(check).toEqual({
      kind: 'compatible',
      oversized: false,
      summary: 'Parakeet TDT v3 (FluidAudio, Core ML)',
      model: {
        id: 'hf-someone--parakeet-tdt-0.6b-v3-coreml',
        name: 'parakeet-tdt-0.6b-v3-coreml',
        task: 'speechToText',
        engine: 'fluidAudio',
        sources: [
          {
            repo: 'someone/parakeet-tdt-0.6b-v3-coreml',
            revision: SHA,
            files: ['Decoder.mlmodelc/', 'Encoder.mlmodelc/', 'JointDecisionv3.mlmodelc/', 'Preprocessor.mlmodelc/', 'parakeet_vocab.json'],
          },
        ],
        sizeBytes,
        memoryBytes: Math.round(sizeBytes * 1.7),
        speed: 'fastest',
        languages: '25 European languages',
        languageCodes: expect.arrayContaining(['bg', 'en', 'uk']),
      },
    })
    expect(downloadedPaths(h)).toEqual([])
  })

  it('rejects an older Parakeet layout FluidAudio would load as the wrong version', async () => {
    const h = hub({ [`FluidInference/parakeet-tdt-0.6b-v2-coreml@${SHA}`]: parakeetRepo('JointDecision') })

    expect(await models(h).checkRepo('FluidInference/parakeet-tdt-0.6b-v2-coreml')).toEqual({
      kind: 'rejected',
      reason: 'missingFiles',
      message: 'FluidInference/parakeet-tdt-0.6b-v2-coreml is missing JointDecisionv3.mlmodelc, which Parakeet TDT v3 needs',
    })
  })
})

describe('Checking an MLX repo', () => {
  it('accepts quantized MLX weights with a supported model_type, reading only the small config files', async () => {
    const h = hub({ [`mlx-community/Qwen3.5-4B-4bit@${SHA}`]: mlxRepo() })

    const check = await models(h).checkRepo('https://huggingface.co/mlx-community/Qwen3.5-4B-4bit')

    expect(check).toEqual({
      kind: 'compatible',
      oversized: false,
      summary: 'MLX qwen3_5, 4-bit',
      model: {
        id: 'hf-mlx-community--Qwen3.5-4B-4bit',
        name: 'Qwen3.5-4B-4bit',
        task: 'chat',
        engine: 'mlx',
        sources: [
          {
            repo: 'mlx-community/Qwen3.5-4B-4bit',
            revision: SHA,
            files: ['chat_template.jinja', 'config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json'],
          },
        ],
        sizeBytes: 46 + 85 + 5000 + 12 + 2,
        memoryBytes: 6500,
        speed: 'fastest',
        languages: 'Languages not listed',
        languageCodes: null,
        chatTemplateContext: { enable_thinking: false },
      },
    })
    expect(downloadedPaths(h)).not.toContain('model.safetensors')
  })

  it('rejects a model_type the MLX engine has no architecture for', async () => {
    const config = { model_type: 'qwen4_exp', quantization: { group_size: 32, bits: 4 } }
    const h = hub({ [`mlx-community/Qwen3.8-Flash-Next-4bit@${SHA}`]: mlxRepo(config) })

    expect(await models(h).checkRepo('mlx-community/Qwen3.8-Flash-Next-4bit')).toEqual({
      kind: 'rejected',
      reason: 'unsupportedArchitecture',
      message: "mlx-community/Qwen3.8-Flash-Next-4bit uses the qwen4_exp architecture, which OpenWispr's MLX engine doesn't support yet",
    })
  })

  it.each([
    {
      weights: 'quantized for Transformers',
      config: { model_type: 'qwen3', quantization_config: { bits: 4, group_size: 128, quant_method: 'awq' } },
      message: "Qwen/Qwen3-4B-AWQ is quantized with awq, which MLX can't load. Look for an MLX version, often from mlx-community",
    },
    {
      weights: 'unquantized',
      config: { model_type: 'qwen3' },
      message:
        "Qwen/Qwen3-4B-AWQ has no MLX quantization config, so its weights aren't quantized for MLX. Look for a 4-bit MLX version, often from mlx-community",
    },
  ])('rejects $weights safetensors as not MLX', async ({ config, message }) => {
    const h = hub({ [`Qwen/Qwen3-4B-AWQ@${SHA}`]: mlxRepo(config) })

    expect(await models(h).checkRepo('Qwen/Qwen3-4B-AWQ')).toEqual({ kind: 'rejected', reason: 'notMlx', message })
  })

  const without = (...paths: string[]) => Object.fromEntries(Object.entries(mlxRepo()).filter(([p]) => !paths.includes(p)))

  it.each([
    { missing: 'config.json', repo: without('config.json'), message: 'config.json' },
    { missing: 'the tokenizer', repo: without('tokenizer.json'), message: 'tokenizer.json' },
    {
      missing: 'a weight shard',
      repo: {
        ...without('model.safetensors'),
        'model.safetensors.index.json': text('{}'),
        'model-00001-of-00003.safetensors': { content: WEIGHTS, lfs: true },
        'model-00003-of-00003.safetensors': { content: WEIGHTS, lfs: true },
      },
      message: 'model-00002-of-00003.safetensors',
    },
  ])('rejects MLX weights without $missing', async ({ repo, message }) => {
    const h = hub({ [`mlx-community/Qwen3.5-4B-4bit@${SHA}`]: repo })

    expect(await models(h).checkRepo('mlx-community/Qwen3.5-4B-4bit')).toEqual({
      kind: 'rejected',
      reason: 'missingFiles',
      message: `mlx-community/Qwen3.5-4B-4bit is missing ${message}, which MLX models need`,
    })
  })

  it('accepts a model only the vision registry knows as a vision model', async () => {
    const config = { model_type: 'qwen3_vl', quantization: { group_size: 64, bits: 4 }, vision_config: {} }
    const h = hub({ [`mlx-community/Qwen3-VL-8B-Instruct-4bit@${SHA}`]: mlxRepo(config) })

    const check = await models(h).checkRepo('mlx-community/Qwen3-VL-8B-Instruct-4bit')

    expect(check).toMatchObject({ kind: 'compatible', model: { task: 'vision', engine: 'mlx' } })
    expect(check.kind === 'compatible' && check.model.chatTemplateContext).toBeFalsy()
  })
})
