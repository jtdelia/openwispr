import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { DownloadState, ModelEntry, ModelSource } from '../shared/modelLibrary'
import { HubError, HUB_HEADERS, hubError, listRepoFiles, resolveUrl, type HubFile } from './huggingFace'
import type { Fetch } from './providers'

export interface ManifestFile extends HubFile {
  /** Relative to the model's folder. */
  localPath: string
}

/** Written into each model's folder; the model process reads the folder, OpenWispr reads this. */
export interface ModelManifest extends ModelEntry {
  userAdded: boolean
  /** False while downloading or after an interruption; true once every file is verified. */
  installed: boolean
  files: ManifestFile[]
}

export interface ModelDownloadsDeps {
  fetch: Fetch
  dir: string
  /** Delay before the first retry of a dropped or stalled transfer; doubles on each further attempt. */
  retryDelayMs: number
  onChange: () => void
}

interface Job {
  controller: AbortController
  done: Promise<void>
  bytesDone: number
  totalBytes: number
  bytesPerSecond: number
  windowStart: number
  windowBytes: number
  lastEmit: number
}

const MANIFEST = 'manifest.json'
const PART = '.part'
const MAX_ATTEMPTS = 5
/** A stalled body stream otherwise hangs forever without an error. */
const STALL_TIMEOUT_MS = 30_000
const PROGRESS_INTERVAL_MS = 250
const SKIPPED = /(^|\/)(\.gitattributes|[^/]*\.md|[^/]*\.(png|jpe?g|gif|webp|svg))$/i

/** Downloads Built-in models from Hugging Face into one folder per model, resuming and verifying files. */
export class ModelDownloads {
  private readonly jobs = new Map<string, Job>()
  private readonly errors = new Map<string, string>()

  constructor(private readonly deps: ModelDownloadsDeps) {}

  /** Resolves when the model is installed or the download was cancelled; rejects when it failed. */
  start(entry: ModelEntry, { userAdded }: { userAdded: boolean }): Promise<void> {
    const running = this.jobs.get(entry.id)
    if (running) return running.done
    const job: Job = {
      controller: new AbortController(),
      done: Promise.resolve(),
      bytesDone: 0,
      totalBytes: entry.sizeBytes,
      bytesPerSecond: 0,
      windowStart: Date.now(),
      windowBytes: 0,
      lastEmit: 0,
    }
    this.jobs.set(entry.id, job)
    this.errors.delete(entry.id)
    job.done = this.run(entry, userAdded, job)
      .catch((error: unknown) => {
        if (job.controller.signal.aborted) return
        this.errors.set(entry.id, error instanceof Error ? error.message : String(error))
        throw error
      })
      .finally(() => {
        this.jobs.delete(entry.id)
        this.deps.onChange()
      })
    this.deps.onChange()
    return job.done
  }

  /** Stops a download and deletes what it fetched so far. */
  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id)
    job?.controller.abort()
    await job?.done.catch(() => undefined)
    await rm(this.folder(id), { recursive: true, force: true })
    this.errors.delete(id)
    this.deps.onChange()
  }

  /** Deletes the model's folder, stopping its download first; returns the bytes freed. */
  async remove(id: string): Promise<number> {
    const job = this.jobs.get(id)
    job?.controller.abort()
    await job?.done.catch(() => undefined)
    const freed = await diskUsage(this.folder(id))
    await rm(this.folder(id), { recursive: true, force: true })
    this.errors.delete(id)
    this.deps.onChange()
    return freed
  }

  async state(id: string): Promise<DownloadState> {
    const job = this.jobs.get(id)
    if (job) {
      return { kind: 'downloading', bytesDone: job.bytesDone, totalBytes: job.totalBytes, bytesPerSecond: job.bytesPerSecond }
    }
    const manifest = await this.manifest(id)
    if (!manifest) return { kind: 'notDownloaded' }
    const totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0)
    if (manifest.installed) return { kind: 'installed', sizeBytes: totalBytes }
    return { kind: 'paused', bytesDone: await this.bytesOnDisk(id, manifest.files), totalBytes, error: this.errors.get(id) ?? null }
  }

  /** Every model with a folder, installed or not. */
  async manifests(): Promise<ModelManifest[]> {
    const entries = await readdir(this.deps.dir, { withFileTypes: true }).catch(() => [])
    const manifests = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => this.manifest(e.name)))
    return manifests.filter((m) => m !== null)
  }

  diskUsage(): Promise<number> {
    return diskUsage(this.deps.dir)
  }

  folder(id: string): string {
    const folder = resolve(this.deps.dir, id)
    if (dirname(folder) !== resolve(this.deps.dir)) throw new Error(`Invalid model id ${id}`)
    return folder
  }

  private async manifest(id: string): Promise<ModelManifest | null> {
    try {
      return JSON.parse(await readFile(join(this.folder(id), MANIFEST), 'utf8')) as ModelManifest
    } catch {
      return null
    }
  }

  private async run(entry: ModelEntry, userAdded: boolean, job: Job): Promise<void> {
    const { signal } = job.controller
    const files = (await Promise.all(entry.sources.map((source) => this.plan(source, signal)))).flat()
    const folder = this.folder(entry.id)
    const manifest: ModelManifest = { ...entry, userAdded, installed: false, files }
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, MANIFEST), JSON.stringify(manifest, null, 2))
    job.totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    job.bytesDone = await this.bytesOnDisk(entry.id, files)
    for (const file of files) await this.fetchFile(folder, file, job)
    await writeFile(join(folder, MANIFEST), JSON.stringify({ ...manifest, installed: true }, null, 2))
  }

  private async plan(source: ModelSource, signal: AbortSignal): Promise<ManifestFile[]> {
    const listed = await listRepoFiles(this.deps.fetch, source, signal)
    const wanted = source.files
    const picked = wanted
      ? listed.filter((file) => wanted.some((w) => (w.endsWith('/') ? file.path.startsWith(w) : file.path === w)))
      : listed.filter((file) => !SKIPPED.test(file.path))
    for (const w of wanted ?? []) {
      if (!picked.some((file) => (w.endsWith('/') ? file.path.startsWith(w) : file.path === w))) {
        throw new Error(`${w} is missing from ${source.repo}`)
      }
    }
    return picked.map((file) => {
      const localPath = source.folder ? file.path.slice(source.folder.length + 1) : file.path
      if (localPath.split('/').some((part) => part === '..' || part === '')) throw new Error(`Unsafe file path ${file.path}`)
      return { ...file, localPath }
    })
  }

  private async fetchFile(folder: string, file: ManifestFile, job: Job): Promise<void> {
    const target = join(folder, file.localPath)
    const part = target + PART
    // Files are only renamed into place after verification.
    if ((await sizeOf(target)) === file.size) return
    await mkdir(dirname(target), { recursive: true })
    for (let attempt = 1; ; attempt++) {
      const before = (await sizeOf(part)) ?? 0
      try {
        await this.transfer(file, part, before, job)
        break
      } catch (error) {
        if (job.controller.signal.aborted) throw error
        if (error instanceof HubError && !error.retryable) throw error
        if (((await sizeOf(part)) ?? 0) > before) attempt = 1
        if (attempt >= MAX_ATTEMPTS) throw error
        await sleep(this.deps.retryDelayMs * 2 ** (attempt - 1), job.controller.signal)
      }
    }
    if (!(await matches(part, file))) {
      await rm(part, { force: true })
      job.bytesDone -= file.size
      throw new Error(`${file.path} didn't match its published ${file.sha256 ? 'SHA-256' : 'Git hash'}, so it was discarded`)
    }
    await rename(part, target)
  }

  /** Appends the rest of `file` to `part`, which already holds `have` bytes. */
  private async transfer(file: ManifestFile, part: string, have: number, job: Job): Promise<void> {
    const stall = new AbortController()
    const signal = AbortSignal.any([job.controller.signal, stall.signal])
    let timer = setTimeout(() => stall.abort(new Error('Download stalled')), STALL_TIMEOUT_MS)
    try {
      const res = await this.deps.fetch(resolveUrl(file), {
        headers: { ...HUB_HEADERS, ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
        signal,
      })
      if (res.status === 416) return
      if (!res.ok) throw await hubError(res, file.repo, file.path)
      let offset = have
      if (res.status === 206) {
        const total = Number(res.headers.get('content-range')?.match(/\/(\d+)$/)?.[1])
        if (total !== file.size) {
          await res.body?.cancel()
          await truncate(part, 0)
          job.bytesDone -= have
          throw new Error(`${file.path} changed on the server`)
        }
      } else {
        // The server ignored the range, so start over.
        offset = 0
        job.bytesDone -= have
      }
      const reader = res.body?.getReader()
      if (!reader) throw new Error(`Empty response for ${file.path}`)
      const stopReading = () => void reader.cancel()
      signal.addEventListener('abort', stopReading)
      const handle = await open(part, offset === 0 ? 'w' : 'a')
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          clearTimeout(timer)
          timer = setTimeout(() => stall.abort(new Error('Download stalled')), STALL_TIMEOUT_MS)
          await handle.write(value)
          this.progress(job, value.length)
        }
        signal.throwIfAborted()
      } finally {
        signal.removeEventListener('abort', stopReading)
        await handle.close()
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private progress(job: Job, bytes: number): void {
    job.bytesDone += bytes
    job.windowBytes += bytes
    const now = Date.now()
    if (now - job.windowStart >= 1000) {
      job.bytesPerSecond = Math.round((job.windowBytes * 1000) / (now - job.windowStart))
      job.windowStart = now
      job.windowBytes = 0
    }
    if (now - job.lastEmit >= PROGRESS_INTERVAL_MS) {
      job.lastEmit = now
      this.deps.onChange()
    }
  }

  private async bytesOnDisk(id: string, files: ManifestFile[]): Promise<number> {
    const folder = this.folder(id)
    const sizes = await Promise.all(
      files.map(async (file) => {
        const target = join(folder, file.localPath)
        return (await sizeOf(target)) ?? (await sizeOf(target + PART)) ?? 0
      }),
    )
    return sizes.reduce((sum, size) => sum + size, 0)
  }
}

/** Checks the published size, then SHA-256 for LFS files or the git blob SHA-1 for the rest. */
async function matches(path: string, file: HubFile): Promise<boolean> {
  if ((await sizeOf(path)) !== file.size) return false
  const hash = file.sha256 ? createHash('sha256') : createHash('sha1').update(`blob ${file.size}\0`)
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex') === (file.sha256 ?? file.gitOid)
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

async function diskUsage(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true, recursive: true }).catch(() => [])
  const sizes = await Promise.all(
    entries.filter((e) => e.isFile()).map((e) => sizeOf(join(e.parentPath, e.name)).then((size) => size ?? 0)),
  )
  return sizes.reduce((sum, size) => sum + size, 0)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
