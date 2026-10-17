import { createHash } from 'node:crypto'

export interface FakeFile {
  content: Buffer
  lfs?: boolean
}

/** Files by path; keyed `<repo>@<sha>` in `fakeHub`. */
export type FakeRepo = Record<string, FakeFile>

/** What the info call reports besides the sha and files. */
export interface FakeRepoInfo {
  gated?: false | 'auto' | 'manual'
  cardData?: Record<string, unknown>
}

export interface FakeHubRequest {
  url: string
  range: string | null
}

export const text = (s: string, lfs = false): FakeFile => ({ content: Buffer.from(s), lfs })
export const json = (value: unknown): FakeFile => text(JSON.stringify(value))

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
export const gitBlobSha1 = (data: Buffer) =>
  createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')

const unauthorized = () => Response.json({ error: 'Invalid username or password.' }, { status: 401 })

/**
 * A test double for the Hugging Face Hub: the info call (`/api/models/<repo>`, its first listed sha being the head of
 * `main`, and `/revision/<rev>`), tree listings (two entries per page, linked with `Link: rel="next"`) and
 * `resolve` downloads honouring `Range`. Unknown repos answer 401, as private and missing repos do
 * anonymously. `override` can answer a `resolve` request instead, to script failures.
 */
export function fakeHub(
  repos: Record<string, FakeRepo>,
  override?: (path: string, request: FakeHubRequest) => Response | undefined,
  info: Record<string, FakeRepoInfo> = {},
) {
  const requests: FakeHubRequest[] = []
  const revisions = (repo: string) =>
    Object.keys(repos)
      .filter((key) => key.startsWith(`${repo}@`))
      .map((key) => key.slice(repo.length + 1))

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const request = { url: url.href, range: headers.get('range') }
    requests.push(request)
    init?.signal?.throwIfAborted()

    const about = url.pathname.match(/^\/api\/models\/([^/]+\/[^/]+)(?:\/revision\/([^/]+))?\/?$/)
    if (about) {
      const [, repo, revision] = about
      const known = revisions(repo)
      if (known.length === 0) return unauthorized()
      const sha = revision === undefined || revision === 'main' ? known[0] : known.find((r) => r === revision)
      if (!sha) {
        return Response.json({ error: 'Invalid rev id' }, { status: 404, headers: { 'x-error-code': 'RevisionNotFound' } })
      }
      return Response.json({
        id: repo,
        sha,
        gated: info[repo]?.gated ?? false,
        private: false,
        ...(info[repo]?.cardData && { cardData: info[repo].cardData }),
        siblings: Object.keys(repos[`${repo}@${sha}`]).map((rfilename) => ({ rfilename })),
      })
    }

    const tree = url.pathname.match(/^\/api\/models\/([^/]+\/[^/]+)\/tree\/([^/]+)\/?(.*)$/)
    if (tree) {
      const [, repo, revision, folder] = tree
      const files = repos[`${repo}@${revision}`]
      if (!files) return unauthorized()
      const entries = Object.entries(files)
        .filter(([path]) => !folder || path.startsWith(`${decodeURIComponent(folder)}/`))
        .flatMap(([path, file]) => [
          ...(path.includes('/') ? [{ type: 'directory', oid: 'd', size: 0, path: path.slice(0, path.lastIndexOf('/')) }] : []),
          {
            type: 'file',
            oid: gitBlobSha1(file.content),
            size: file.content.length,
            path,
            ...(file.lfs ? { lfs: { oid: sha256(file.content), size: file.content.length, pointerSize: 135 } } : {}),
          },
        ])
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      const next = new URL(url)
      next.searchParams.set('cursor', String(cursor + 2))
      return Response.json(entries.slice(cursor, cursor + 2), {
        headers: cursor + 2 < entries.length ? { Link: `<${next.href}>; rel="next"` } : {},
      })
    }

    const resolve = url.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/)
    if (resolve) {
      const [, repo, revision, encodedPath] = resolve
      const path = decodeURIComponent(encodedPath)
      const overridden = override?.(path, request)
      if (overridden) return overridden
      if (info[repo]?.gated) {
        return new Response('Access restricted', {
          status: 401,
          headers: { 'x-error-code': 'GatedRepo', 'x-error-message': `Access to model ${repo} is restricted.` },
        })
      }
      const file = repos[`${repo}@${revision}`]?.[path]
      if (!file) return new Response('Entry not found', { status: 404, headers: { 'x-error-code': 'EntryNotFound' } })
      const from = Number(request.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0)
      if (!request.range) return new Response(file.content)
      if (from >= file.content.length) return new Response(null, { status: 416 })
      return new Response(file.content.subarray(from), {
        status: 206,
        headers: { 'content-range': `bytes ${from}-${file.content.length - 1}/${file.content.length}` },
      })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetch: fetch as typeof globalThis.fetch, requests }
}

export type FakeHub = ReturnType<typeof fakeHub>
