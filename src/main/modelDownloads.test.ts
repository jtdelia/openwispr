import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHub, gitBlobSha1, sha256, text, type FakeRepo } from './fakeHub'
import type { ModelProcessTransport, ModelRequest } from './modelProcess'
import { Models, type ModelSettings } from './models'

const SETTINGS: ModelSettings = {
  speechToText: { kind: 'builtIn', modelId: 'apple' },
  chat: { kind: 'builtIn', modelId: 'apple' },
  language: '',
}

const GB = 1_000_000_000

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openwispr-models-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A model process that answers every request at once, recording them. */
function recordingModelProcess() {
  const requests: ModelRequest[] = []
  const transport: ModelProcessTransport = {
    start: (handlers) => ({
      send(request) {
        requests.push(request)
        queueMicrotask(() => handlers.message({ type: 'response', id: request.id, result: {} }))
      },
      stop: () => queueMicrotask(() => handlers.exit(null)),
    }),
  }
  return { transport, requests }
}

function models(
  hub: ReturnType<typeof fakeHub>,
  physicalMemoryBytes = 32 * GB,
  { settings = SETTINGS, transport = recordingModelProcess().transport } = {},
) {
  return new Models({
    fetch: hub.fetch,
    settings: () => settings,
    transport,
    modelsDir: dir,
    physicalMemoryBytes,
    retryDelayMs: 0,
  })
}

async function status(m: Models, id: string) {
  const library = await m.library()
  const found = library.models.find((s) => s.model.id === id)
  if (!found) throw new Error(`no model ${id}`)
  return found
}

const WHISPERKIT = 'argmaxinc/whisperkit-coreml@0f63a7800b00dd0226abd051b906c246e1907482'
const WHISPER_SMALL = 'openai/whisper-small@973afd24965f72e36ca33b3055d56a652f456b4d'
const QWEN = 'mlx-community/Qwen3-4B-Instruct-2507-4bit@50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b'

const WEIGHTS = Buffer.alloc(5000, 7)

describe('Model downloads', () => {
  it('lists files from Hugging Face at the pinned revision and installs them in the model folder', async () => {
    const hub = fakeHub({
      [WHISPERKIT]: {
        'README.md': text('# WhisperKit'),
        'openai_whisper-small_216MB/config.json': text('{"d_model":768}'),
        'openai_whisper-small_216MB/AudioEncoder.mlmodelc/model.mil': text('program(1.0)'),
        'openai_whisper-small_216MB/AudioEncoder.mlmodelc/weights/weight.bin': { content: WEIGHTS, lfs: true },
        'openai_whisper-tiny/config.json': text('{"d_model":384}'),
      },
      [WHISPER_SMALL]: {
        'README.md': text('# Whisper'),
        'model.safetensors': { content: Buffer.alloc(100), lfs: true },
        'tokenizer.json': text('{"model":{}}'),
        'tokenizer_config.json': text('{}'),
      },
    })
    const m = models(hub)

    await m.download('whisper-small')

    const listings = hub.requests.filter((r) => r.url.includes('/tree/')).map((r) => r.url)
    expect(listings[0]).toBe(
      'https://huggingface.co/api/models/argmaxinc/whisperkit-coreml/tree/0f63a7800b00dd0226abd051b906c246e1907482/openai_whisper-small_216MB?recursive=true',
    )
    expect(listings).toContain(
      'https://huggingface.co/api/models/openai/whisper-small/tree/973afd24965f72e36ca33b3055d56a652f456b4d?recursive=true',
    )
    const downloads = hub.requests.filter((r) => r.url.includes('/resolve/')).map((r) => r.url)
    expect(downloads.sort()).toEqual([
      'https://huggingface.co/argmaxinc/whisperkit-coreml/resolve/0f63a7800b00dd0226abd051b906c246e1907482/openai_whisper-small_216MB/AudioEncoder.mlmodelc/model.mil',
      'https://huggingface.co/argmaxinc/whisperkit-coreml/resolve/0f63a7800b00dd0226abd051b906c246e1907482/openai_whisper-small_216MB/AudioEncoder.mlmodelc/weights/weight.bin',
      'https://huggingface.co/argmaxinc/whisperkit-coreml/resolve/0f63a7800b00dd0226abd051b906c246e1907482/openai_whisper-small_216MB/config.json',
      'https://huggingface.co/openai/whisper-small/resolve/973afd24965f72e36ca33b3055d56a652f456b4d/tokenizer.json',
      'https://huggingface.co/openai/whisper-small/resolve/973afd24965f72e36ca33b3055d56a652f456b4d/tokenizer_config.json',
    ])

    const folder = join(dir, 'whisper-small')
    expect(await readFile(join(folder, 'config.json'), 'utf8')).toBe('{"d_model":768}')
    expect(await readFile(join(folder, 'AudioEncoder.mlmodelc/weights/weight.bin'))).toEqual(WEIGHTS)
    expect(await readFile(join(folder, 'tokenizer.json'), 'utf8')).toBe('{"model":{}}')
    expect(existsSync(join(folder, 'README.md'))).toBe(false)

    const installedBytes = 15 + 12 + 5000 + 12 + 2
    expect((await status(m, 'whisper-small')).state).toEqual({ kind: 'installed', sizeBytes: installedBytes })
    const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ id: 'whisper-small', engine: 'whisperKit', task: 'speechToText', userAdded: false })
    expect(manifest.files).toContainEqual<unknown>({
      repo: 'argmaxinc/whisperkit-coreml',
      revision: '0f63a7800b00dd0226abd051b906c246e1907482',
      path: 'openai_whisper-small_216MB/AudioEncoder.mlmodelc/weights/weight.bin',
      localPath: 'AudioEncoder.mlmodelc/weights/weight.bin',
      size: 5000,
      sha256: sha256(WEIGHTS),
      gitOid: gitBlobSha1(WEIGHTS),
    })
  })
})

/** A response that sends the first `bytes` of `content`, then fails like a dropped connection. */
function droppedAfter(content: Buffer, bytes: number): Response {
  let sent = false
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent) return controller.error(new TypeError('terminated'))
        sent = true
        controller.enqueue(new Uint8Array(content.subarray(0, bytes)))
      },
    }),
  )
}

const qwenRepo = (): FakeRepo => ({
  '.gitattributes': text('*.safetensors filter=lfs'),
  'README.md': text('# Qwen'),
  'config.json': text('{"model_type":"qwen3"}'),
  'model.safetensors': { content: WEIGHTS, lfs: true },
})

const weightRequests = (hub: ReturnType<typeof fakeHub>) =>
  hub.requests.filter((r) => r.url.endsWith('/model.safetensors')).map((r) => r.range)

describe('Verifying downloads', () => {
  const corrupt = (target: string) => (path: string) =>
    path === target ? new Response(Buffer.alloc(qwenRepo()[target].content.length, 1)) : undefined

  it('discards a file whose SHA-256 differs from the published one and reports it', async () => {
    const m = models(fakeHub({ [QWEN]: qwenRepo() }, corrupt('model.safetensors')))

    await expect(m.download('qwen3-4b-instruct-2507')).rejects.toThrow(
      "model.safetensors didn't match its published SHA-256, so it was discarded",
    )

    const folder = join(dir, 'qwen3-4b-instruct-2507')
    expect(existsSync(join(folder, 'model.safetensors'))).toBe(false)
    expect(existsSync(join(folder, 'model.safetensors.part'))).toBe(false)
    expect((await status(m, 'qwen3-4b-instruct-2507')).state).toEqual({
      kind: 'paused',
      bytesDone: 22,
      totalBytes: 5022,
      error: "model.safetensors didn't match its published SHA-256, so it was discarded",
    })
  })

  it('checks small files without a SHA-256 against their git blob hash', async () => {
    const m = models(fakeHub({ [QWEN]: qwenRepo() }, corrupt('config.json')))

    await expect(m.download('qwen3-4b-instruct-2507')).rejects.toThrow(
      "config.json didn't match its published Git hash, so it was discarded",
    )
    expect(existsSync(join(dir, 'qwen3-4b-instruct-2507/config.json'))).toBe(false)
  })

  it('stops a download that runs past the published size instead of filling the disk', async () => {
    const endless = () => new Response(new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(1000)) }))
    const hub = fakeHub({ [QWEN]: qwenRepo() }, (path) => (path === 'model.safetensors' ? endless() : undefined))
    const m = models(hub)

    await expect(m.download('qwen3-4b-instruct-2507')).rejects.toThrow(
      'model.safetensors is larger than Hugging Face lists it, so it was discarded',
    )
    expect(weightRequests(hub)).toEqual([null])
    expect((await status(m, 'qwen3-4b-instruct-2507')).state).toMatchObject({ kind: 'paused', bytesDone: 22 })
  })
})

describe('Cancelling, removing and disk usage', () => {
  /** Sends the first `bytes`, then never sends anything else. */
  const hangsAfter = (content: Buffer, bytes: number) => {
    let sent = false
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (sent) return new Promise<void>(() => undefined)
          sent = true
          controller.enqueue(new Uint8Array(content.subarray(0, bytes)))
        },
      }),
    )
  }

  it('cancels a running download and discards what it fetched', async () => {
    const hub = fakeHub({ [QWEN]: qwenRepo() }, (path) => (path === 'model.safetensors' ? hangsAfter(WEIGHTS, 1000) : undefined))
    const m = models(hub)
    const download = m.download('qwen3-4b-instruct-2507')
    await vi.waitFor(async () =>
      expect((await status(m, 'qwen3-4b-instruct-2507')).state).toMatchObject({ kind: 'downloading', bytesDone: 1022, totalBytes: 5022 }),
    )
    expect((await m.library()).diskUsageBytes).toBeGreaterThan(1022)

    await m.cancelDownload('qwen3-4b-instruct-2507')

    await expect(download).resolves.toBeUndefined()
    expect((await status(m, 'qwen3-4b-instruct-2507')).state).toEqual({ kind: 'notDownloaded' })
    expect(existsSync(join(dir, 'qwen3-4b-instruct-2507'))).toBe(false)
    expect((await m.library()).diskUsageBytes).toBe(0)
  })

  it('removes an installed model, reporting the space freed, and totals disk usage across models', async () => {
    const hub = fakeHub({
      [QWEN]: qwenRepo(),
      [WHISPERKIT]: { 'openai_whisper-small_216MB/config.json': text('{"d_model":768}') },
      [WHISPER_SMALL]: { 'tokenizer.json': text('{"model":{}}'), 'tokenizer_config.json': text('{}') },
    })
    const m = models(hub)
    await m.download('qwen3-4b-instruct-2507')
    await m.download('whisper-small')
    const qwenManifest = (await readFile(join(dir, 'qwen3-4b-instruct-2507/manifest.json'))).length
    const whisperManifest = (await readFile(join(dir, 'whisper-small/manifest.json'))).length
    expect((await m.library()).diskUsageBytes).toBe(5022 + qwenManifest + 29 + whisperManifest)

    expect(await m.removeModel('qwen3-4b-instruct-2507')).toBe(5022 + qwenManifest)

    expect((await status(m, 'qwen3-4b-instruct-2507')).state).toEqual({ kind: 'notDownloaded' })
    expect((await status(m, 'whisper-small')).state.kind).toBe('installed')
    expect((await m.library()).diskUsageBytes).toBe(29 + whisperManifest)
  })

  it('unloads a removed model once requests using it finish, so a reinstall loads its new files', async () => {
    const requests: ModelRequest[] = []
    const held: Array<() => void> = []
    const transport: ModelProcessTransport = {
      start: (handlers) => ({
        send(request) {
          requests.push(request)
          const answer = () => handlers.message({ type: 'response', id: request.id, result: {} })
          if (request.type === 'load') held.push(answer)
          else queueMicrotask(answer)
        },
        stop: () => queueMicrotask(() => handlers.exit(null)),
      }),
    }
    const m = models(
      fakeHub({
        [WHISPERKIT]: { 'openai_whisper-small_216MB/config.json': text('{"d_model":768}') },
        [WHISPER_SMALL]: { 'tokenizer.json': text('{"model":{}}'), 'tokenizer_config.json': text('{}') },
      }),
      32 * GB,
      { transport },
    )
    await m.download('whisper-small')
    await vi.waitFor(() => expect(held).toHaveLength(1))

    const removing = m.removeModel('whisper-small')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests.map((r) => r.type)).toEqual(['load'])
    expect(existsSync(join(dir, 'whisper-small/config.json'))).toBe(true)

    held[0]()
    await removing

    expect(requests.at(-1)).toEqual({ id: expect.any(Number), type: 'unload', models: ['whisper-small'] })
    expect(existsSync(join(dir, 'whisper-small'))).toBe(false)
  })
})

describe('Using a downloaded model', () => {
  const whisperSmallRepos = () => ({
    [WHISPERKIT]: { 'openai_whisper-small_216MB/config.json': text('{"d_model":768}') },
    [WHISPER_SMALL]: { 'tokenizer.json': text('{"model":{}}'), 'tokenizer_config.json': text('{}') },
  })

  it('makes a speech-to-text model selectable once installed, and loads it right away so its first dictation is quick', async () => {
    const process = recordingModelProcess()
    const settings: ModelSettings = { ...SETTINGS, speechToText: { kind: 'builtIn', modelId: 'whisper-small' }, language: 'fr' }
    const m = models(fakeHub(whisperSmallRepos()), 32 * GB, { settings, transport: process.transport })
    await m.ready
    expect(m.availability('speechToText').available).toBe(false)

    await m.download('whisper-small')

    expect(m.availability('speechToText')).toEqual({ available: true })
    await vi.waitFor(() =>
      expect(process.requests).toEqual([
        { id: expect.any(Number), type: 'load', models: [{ role: 'speechToText', id: 'whisper-small', language: 'fr' }] },
      ]),
    )
  })

  it('does not load a downloaded chat model until it is used, since it would hold its memory', async () => {
    const process = recordingModelProcess()
    await models(fakeHub({ [QWEN]: qwenRepo() }), 32 * GB, { transport: process.transport }).download('qwen3-4b-instruct-2507')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(process.requests).toEqual([])
  })
})

describe('Recommended models', () => {
  it('lists speech-to-text, chat and vision models, flagging those needing over 60% of memory', async () => {
    const library = await models(fakeHub({}), 8 * GB).library()

    expect(new Set(library.models.map((s) => s.model.task))).toEqual(new Set(['speechToText', 'chat', 'vision']))
    expect(library.models.every((s) => s.recommended && s.state.kind === 'notDownloaded')).toBe(true)
    expect(library.models.filter((s) => s.oversized).map((s) => s.model.id)).toEqual(['qwen3.5-9b', 'gemma-4-e4b'])
    expect(library.physicalMemoryBytes).toBe(8 * GB)
    expect(library.diskUsageBytes).toBe(0)
  })
})

describe('Resuming downloads', () => {
  it('picks up where a dropped connection stopped with a range request', async () => {
    let dropped = false
    const hub = fakeHub({ [QWEN]: qwenRepo() }, (path) => {
      if (path !== 'model.safetensors' || dropped) return undefined
      dropped = true
      return droppedAfter(WEIGHTS, 2000)
    })
    const m = models(hub)

    await m.download('qwen3-4b-instruct-2507')

    expect(weightRequests(hub)).toEqual([null, 'bytes=2000-'])
    expect(await readFile(join(dir, 'qwen3-4b-instruct-2507/model.safetensors'))).toEqual(WEIGHTS)
    expect((await status(m, 'qwen3-4b-instruct-2507')).state).toEqual({ kind: 'installed', sizeBytes: 22 + 5000 })
  })

  it('keeps the partial file when the network stays down, and resumes it after a restart', async () => {
    let dropped = false
    const offline = fakeHub({ [QWEN]: qwenRepo() }, (path) => {
      if (path !== 'model.safetensors') return undefined
      if (dropped) throw new TypeError('fetch failed')
      dropped = true
      return droppedAfter(WEIGHTS, 2000)
    })
    const first = models(offline)
    await expect(first.download('qwen3-4b-instruct-2507')).rejects.toThrow('fetch failed')
    expect((await status(first, 'qwen3-4b-instruct-2507')).state).toEqual({
      kind: 'paused',
      bytesDone: 22 + 2000,
      totalBytes: 22 + 5000,
      error: 'fetch failed',
    })

    const online = fakeHub({ [QWEN]: qwenRepo() })
    const afterRestart = models(online)
    expect((await status(afterRestart, 'qwen3-4b-instruct-2507')).state).toMatchObject({ kind: 'paused', bytesDone: 2022 })
    await afterRestart.download('qwen3-4b-instruct-2507')

    expect(weightRequests(online)).toEqual(['bytes=2000-'])
    expect(online.requests.some((r) => r.url.endsWith('/config.json'))).toBe(false)
    expect(await readFile(join(dir, 'qwen3-4b-instruct-2507/model.safetensors'))).toEqual(WEIGHTS)
    expect((await status(afterRestart, 'qwen3-4b-instruct-2507')).state.kind).toBe('installed')
  })

  it('starts the file over when the server ignores the range', async () => {
    let dropped = false
    const hub = fakeHub({ [QWEN]: qwenRepo() }, (path, request) => {
      if (path !== 'model.safetensors') return undefined
      if (!dropped) {
        dropped = true
        return droppedAfter(WEIGHTS, 2000)
      }
      expect(request.range).toBe('bytes=2000-')
      return new Response(WEIGHTS)
    })

    await models(hub).download('qwen3-4b-instruct-2507')

    expect(await readFile(join(dir, 'qwen3-4b-instruct-2507/model.safetensors'))).toEqual(WEIGHTS)
  })
})
