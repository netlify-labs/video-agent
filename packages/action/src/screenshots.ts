// Screenshots for the run (github-action plan §3.7, bead va-mg4i.2.12): images from the PR description (only when its
// author is trusted) or workspace files, downloaded defensively, uploaded to the media library, and removed from the
// library once the version is done (the version keeps its own copy). Items the library already had are never deleted.
import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join, relative, resolve, sep } from 'node:path'
import { isPrivateAddress } from '../../../app/server/adapters/http.js'
import { screenshotCaption } from '../../cli/src/brief/index.js'
import type { VideoAgent } from '../../sdk/src/index.js'
import { GitHubError, type GitHub } from './github.js'
import type { Run } from './main.js'

export const MAX_SHOTS = 6
export const MAX_BYTES = 4 * 1024 * 1024
const MAX_REDIRECTS = 3

export interface Shot {
  bytes: Uint8Array
  ext: 'png' | 'jpg' | 'gif' | 'webp'
  alt: string
  source: string
}

export interface Prepared {
  /** Media ids for the run, in order. */
  mediaIds: string[]
  /** Ids this run uploaded (deleted after the version is done). */
  uploaded: string[]
  captions: string[]
}

/** The image type from its first bytes, never from Content-Type. */
export function sniff(b: Uint8Array): Shot['ext'] | null {
  const at = (i: number) => b[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'gif'
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  return null
}

/** Image links in a Markdown/HTML body, in order: ![alt](url) and <img src alt>. */
export function imageLinks(body: string): { url: string; alt: string }[] {
  const out: { at: number; url: string; alt: string }[] = []
  for (const m of body.matchAll(/!\[([^\]]*)\]\(\s*<?(https?:[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g))
    out.push({ at: m.index, url: m[2] ?? '', alt: m[1] ?? '' })
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const src = /\ssrc=["']([^"']+)["']/i.exec(tag)?.[1]
    const alt = /\salt=["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
    if (src) out.push({ at: m.index, url: src.replace(/&amp;/g, '&'), alt })
  }
  return out.sort((a, b) => a.at - b.at).map(({ url, alt }) => ({ url, alt }))
}

const isAttachment = (url: string) => /^https:\/\/github\.com\/user-attachments\/assets\//.test(url)

type Skip =
  | 'private-attachment'
  | 'too-big'
  | 'type'
  | 'private-address'
  | 'redirects'
  | 'http'
  | 'outside-workspace'
  | 'not-in-repo'

/** A branch name has at most this many path segments when we look for where the ref ends and the path starts. */
const MAX_REF_SEGMENTS = 4

/**
 * A link to a file in this repository (github.com/<owner>/<repo>/blob|raw/<ref>/<path>, with or without ?raw=true, or
 * raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>): the segments after the repository, ref first. Null for any
 * other link. In a private repository these answer 404 without credentials, so they're read through the API instead.
 */
export function repoFile(url: string, serverUrl: string, owner: string, repo: string): string[] | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  let segs: string[]
  try {
    segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  const same = (a: string | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase()
  if (!same(segs[0], owner) || !same(segs[1], repo)) return null
  let rest: string[]
  if (u.host === new URL(serverUrl).host && (segs[2] === 'blob' || segs[2] === 'raw')) rest = segs.slice(3)
  else if (u.host === 'raw.githubusercontent.com') rest = segs.slice(2)
  else return null
  if (rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags')) rest = rest.slice(2)
  return rest.length >= 2 && !rest.includes('..') ? rest : null
}

interface Contents {
  type?: string
  size?: number
  encoding?: string
  content?: string
  download_url?: string | null
}

/**
 * Reads a file of this repository with the workflow's token (it needs contents: read). The token goes to the GitHub
 * API only, never to an image host. A branch name can hold slashes, so each split of ref/path is tried, shortest ref
 * first, until one exists.
 */
export async function fromRepo(run: Run, gh: GitHub, segs: string[]): Promise<Uint8Array | Skip> {
  for (let k = 1; k < segs.length && k <= MAX_REF_SEGMENTS; k++) {
    let data: Contents | Contents[]
    try {
      const res = await gh.request<Contents | Contents[]>('GET /repos/{owner}/{repo}/contents/{path}', {
        path: { path: segs.slice(k).join('/') },
        query: { ref: segs.slice(0, k).join('/') },
      })
      data = res.data
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) continue
      return 'http'
    }
    if (Array.isArray(data) || data.type !== 'file') continue
    if ((data.size ?? 0) > MAX_BYTES) return 'too-big'
    if (data.encoding === 'base64' && data.content) return new Uint8Array(Buffer.from(data.content, 'base64'))
    // Over 1 MB the API leaves the content out; its download_url is signed for a few minutes and needs no credentials.
    return data.download_url ? download(run, data.download_url) : 'http'
  }
  return 'not-in-repo'
}

/** Downloads one image: HTTPS only, at most 3 redirects, every host public, no credentials, 4 MB, a real image. */
export async function download(run: Run, url: string): Promise<Uint8Array | Skip> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current)
    if (u.protocol !== 'https:' || u.username || u.password) return 'http'
    const host = u.hostname.replace(/^\[|\]$/g, '')
    const addrs = isIP(host) ? [host] : await run.deps.resolve(host).catch(() => [])
    if (addrs.length === 0 || addrs.some(isPrivateAddress)) return 'private-address'
    // No Authorization or cookies to an image host (§4.12): a plain GET.
    const res = await run.deps.imageFetch(current, { redirect: 'manual', headers: { accept: 'image/*' } })
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      await res.body?.cancel()
      if (!next) return 'http'
      current = new URL(next, current).toString()
      continue
    }
    if (!res.ok) {
      await res.body?.cancel()
      return isAttachment(url) ? 'private-attachment' : 'http'
    }
    const length = Number(res.headers.get('content-length') ?? '0')
    if (length > MAX_BYTES) {
      await res.body?.cancel()
      return 'too-big'
    }
    const chunks: Uint8Array[] = []
    let total = 0
    // Stop reading at 4 MB + 1, whatever Content-Length said.
    if (res.body)
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength
        if (total > MAX_BYTES) return 'too-big'
        chunks.push(chunk)
      }
    const bytes = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      bytes.set(c, at)
      at += c.byteLength
    }
    return bytes
  }
  return 'redirects'
}

/**
 * The signed private-user-images URLs GraphQL bodyHTML gives for a PR's attachments, in order (spike A4: the
 * user-attachments links 404 with or without the token; the signed URLs live 300 s and need no auth).
 */
export async function signedAttachments(gh: GitHub, pr: number): Promise<string[]> {
  const data = await gh.graphql<{ repository: { pullRequest: { bodyHTML: string } | null } }>(
    'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){bodyHTML}}}',
    { owner: gh.owner, repo: gh.repo, number: pr },
  )
  const html = data.repository.pullRequest?.bodyHTML ?? ''
  return imageLinks(html)
    .map((l) => l.url)
    .filter((u) => u.startsWith('https://private-user-images.githubusercontent.com/'))
}

/**
 * Images from a PR description, at most 6, skipping (with a log line) any that can't be used. Files of this
 * repository are read through the API, uploads through their signed URLs, anything else with a plain GET.
 */
export async function fromBody(run: Run, gh: GitHub, pr: number, body: string): Promise<Shot[]> {
  const links = imageLinks(body).slice(0, MAX_SHOTS)
  let signed: string[] | null = null
  const shots: Shot[] = []
  let attachmentIndex = 0
  for (const link of links) {
    let url = link.url
    if (isAttachment(url)) {
      signed ??= await signedAttachments(gh, pr).catch(() => [])
      url = signed[attachmentIndex++] ?? url
    }
    const inRepo = repoFile(url, run.ctx.serverUrl, gh.owner, gh.repo)
    const got = inRepo ? await fromRepo(run, gh, inRepo) : await download(run, url)
    if (typeof got === 'string') {
      run.log.line({ screenshot: 'skipped', reason: got, url: new URL(link.url).host })
      continue
    }
    const ext = sniff(got)
    if (!ext) {
      run.log.line({ screenshot: 'skipped', reason: 'type', url: new URL(link.url).host })
      continue
    }
    shots.push({ bytes: got, ext, alt: link.alt, source: new URL(link.url).host })
  }
  return shots
}

/** `dir/*.png`-style globs: * and ? within one path segment; never outside the workspace; symlinks not followed. */
export async function fromGlob(run: Run, pattern: string): Promise<Shot[]> {
  const root = resolve(run.deps.cwd)
  const parts = pattern.split('/').filter(Boolean)
  const toRe = (seg: string) =>
    new RegExp(
      `^${seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')}$`,
    )
  let dirs = [root]
  const files: string[] = []
  for (const [i, seg] of parts.entries()) {
    const last = i === parts.length - 1
    const next: string[] = []
    for (const dir of dirs) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!toRe(seg).test(e.name) || e.isSymbolicLink()) continue
        const p = join(dir, e.name)
        if (last ? e.isFile() : e.isDirectory()) (last ? files : next).push(p)
      }
    }
    dirs = next
  }
  const shots: Shot[] = []
  for (const file of files.slice(0, MAX_SHOTS)) {
    const rel = relative(root, file)
    if (rel.startsWith('..') || rel.split(sep).includes('..')) continue
    const st = await lstat(file)
    if (st.isSymbolicLink() || st.size > MAX_BYTES) {
      run.log.line({
        screenshot: 'skipped',
        reason: st.size > MAX_BYTES ? 'too-big' : 'outside-workspace',
        file: rel,
      })
      continue
    }
    const bytes = await run.deps.readFile(file)
    const ext = sniff(bytes)
    if (!ext) {
      run.log.line({ screenshot: 'skipped', reason: 'type', file: rel })
      continue
    }
    shots.push({ bytes, ext, alt: '', source: rel })
  }
  return shots
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** Puts the shots in the library: reuses identical items (never deleted later), uploads the rest. */
export async function prepare(run: Run, va: VideoAgent, shots: Shot[], pr: number | null): Promise<Prepared> {
  const out: Prepared = { mediaIds: [], uploaded: [], captions: [] }
  for (const [i, s] of shots.entries()) {
    const n = i + 1
    const filename = pr === null ? `ci-shot-${n}.${s.ext}` : `pr-${pr}-${n}.${s.ext}`
    const caption =
      pr === null ? `Screenshot ${n}${s.alt ? `: ${s.alt}` : ''}` : screenshotCaption(pr, n, s.alt)
    const check = await va.media.check({ files: [{ filename, sha256: sha256(s.bytes) }] })
    const same = check.files[0]?.sameFile
    if (same) {
      out.mediaIds.push(same.id)
      out.captions.push(same.caption ?? caption)
      run.log.line({ screenshot: 'reused', media: same.id })
      continue
    }
    let item: { id: string }
    try {
      item = await va.media.upload(s.bytes, { filename, caption: caption.slice(0, 200), dedupe: false })
    } catch (e) {
      // The server checks images again; one it refuses is skipped, and the run carries on (§3.11).
      const status = (e as { status?: number }).status ?? 0
      if (status < 400 || status >= 500 || status === 401 || status === 403) throw e
      run.log.line({ screenshot: 'skipped', reason: 'refused', source: s.source, status })
      continue
    }
    out.mediaIds.push(item.id)
    out.uploaded.push(item.id)
    out.captions.push(caption)
    run.log.line({ screenshot: 'uploaded', media: item.id, bytes: s.bytes.byteLength })
  }
  return out
}

/** Removes uploaded items from the library (a soft delete: versions keep their snapshot). A 404 counts as done. */
export async function cleanup(run: Run, va: VideoAgent, ids: readonly string[]): Promise<string[]> {
  const left: string[] = []
  for (const id of ids) {
    try {
      await va.media.delete(id)
      run.log.line({ screenshot: 'deleted', media: id })
    } catch (e) {
      if ((e as { status?: number }).status === 404) continue
      left.push(id)
      run.log.warn(`couldn't remove screenshot ${id} from the library`)
    }
  }
  return left
}
