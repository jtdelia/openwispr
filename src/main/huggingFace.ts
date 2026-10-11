import type { Fetch } from './providers'

const HUB = 'https://huggingface.co'

export const HUB_HEADERS = { 'User-Agent': 'OpenWispr' }

/** A file in a Hugging Face repo at a pinned commit. */
export interface HubFile {
  repo: string
  revision: string
  path: string
  size: number
  /** Published only for files stored in Git LFS. */
  sha256: string | null
  /** Git blob SHA-1, `sha1("blob <size>\0" + bytes)`, published for every file. */
  gitOid: string
}

interface TreeEntry {
  type: 'file' | 'directory'
  path: string
  size: number
  oid: string
  lfs?: { oid: string; size: number }
}

export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }

  /** Rate limits and server errors may pass; anything else will fail the same way again. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

/** Every file in `repo` at `revision`, or only those under `folder`, following pagination. */
export async function listRepoFiles(
  fetch: Fetch,
  { repo, revision, folder }: { repo: string; revision: string; folder?: string },
  signal?: AbortSignal,
): Promise<HubFile[]> {
  const files: HubFile[] = []
  let url: string | null =
    `${HUB}/api/models/${repo}/tree/${revision}${folder ? `/${encodePath(folder)}` : ''}?recursive=true`
  while (url) {
    const res = await fetch(url, { headers: HUB_HEADERS, signal })
    if (!res.ok) throw await hubError(res, repo)
    for (const entry of (await res.json()) as TreeEntry[]) {
      if (entry.type !== 'file') continue
      files.push({
        repo,
        revision,
        path: entry.path,
        size: entry.lfs?.size ?? entry.size,
        sha256: entry.lfs?.oid ?? null,
        gitOid: entry.oid,
      })
    }
    url = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null
  }
  return files
}

/** Redirects to a signed CDN URL that expires, so request this again for every (re)start. */
export function resolveUrl(file: Pick<HubFile, 'repo' | 'revision' | 'path'>): string {
  return `${HUB}/${file.repo}/resolve/${file.revision}/${encodePath(file.path)}`
}

export async function hubError(res: Response, repo: string, path?: string): Promise<HubError> {
  const code = res.headers.get('x-error-code')
  const message = (() => {
    if (code === 'GatedRepo') return `${repo} is gated: its owner must grant access first`
    if (code === 'RevisionNotFound') return `${repo} has no such revision`
    if (code === 'EntryNotFound') return `${path ?? 'A file'} is missing from ${repo}`
    // Anonymously, a private repo answers exactly like a missing one.
    if (res.status === 401) return `${repo} was not found or is private`
    if (res.status === 429) return 'Hugging Face is rate limiting downloads; try again shortly'
    return `Hugging Face answered ${res.status}${path ? ` for ${path}` : ''}`
  })()
  await res.body?.cancel()
  return new HubError(message, res.status)
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
