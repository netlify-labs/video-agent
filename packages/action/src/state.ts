// One video per PR or release (github-action plan §3.5, bead va-mg4i.2.7). The server is the memory: every brief ends
// with a reference line the list's search finds. The sticky comment's hidden marker caches the answer. Idempotency keys
// carry the run id, so a re-run of a run never makes a second video and a new run never meets an old key.
import { createHash } from 'node:crypto'
import { endsWithRef, refFor, type Target as RefTarget } from '../../cli/src/brief/index.js'
import type { components, VideoAgent } from '../../sdk/src/index.js'
import { GitHubError, type GitHub } from './github.js'
import type { Log } from './log.js'

export type Video = components['schemas']['Video']
export type Version = components['schemas']['Version']

// ───── keys ─────

export const KEY_MAX = 200

/** At most 200 characters: a longer key keeps a prefix and ends with `:h` + 16 hex of its sha256 (stable). */
export function capKey(key: string): string {
  if (key.length <= KEY_MAX) return key
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return `${key.slice(0, KEY_MAX - hash.length - 2)}:h${hash}`
}

const base = (t: RefTarget) =>
  t.kind === 'pr' ? `gh:${t.owner}/${t.repo}#pr-${t.number}` : `gh:${t.owner}/${t.repo}@${t.tag}`

export const keys = {
  create: (t: RefTarget, runId: string) => capKey(`${base(t)}:create:${runId}`),
  revise: (t: RefTarget, headSha: string, runId: string) => capKey(`${base(t)}:rev:${headSha}:${runId}`),
  command: (t: RefTarget, commentId: number) => capKey(`${base(t)}:cmd:${commentId}`),
  dispatch: (owner: string, repo: string, runId: string) => capKey(`gh:${owner}/${repo}:dispatch:${runId}`),
}

// ───── the marker ─────

export interface Marker {
  videoId: string
  headSha?: string
  /** Versions this action made for the PR or release. */
  made?: number
  /** Screenshots uploaded but not cleaned up yet (the job stopped waiting first). */
  pending?: string[]
}

const MARKER = /<!-- video-agent:v1 (\{.*?\}) -->/

export const renderMarker = (m: Marker) => `<!-- video-agent:v1 ${JSON.stringify(m)} -->`

/** The marker in a body, or null (none, or broken JSON, which is warned about). */
export function parseMarker(body: string, log?: Log): Marker | null {
  const m = MARKER.exec(body)
  if (!m?.[1]) return null
  try {
    const parsed = JSON.parse(m[1]) as Partial<Marker>
    if (typeof parsed.videoId !== 'string') throw new Error('no videoId')
    return {
      videoId: parsed.videoId,
      ...(typeof parsed.headSha === 'string' ? { headSha: parsed.headSha } : {}),
      ...(typeof parsed.made === 'number' ? { made: parsed.made } : {}),
      ...(Array.isArray(parsed.pending)
        ? { pending: parsed.pending.filter((x) => typeof x === 'string') }
        : {}),
    }
  } catch {
    log?.warn('ignored a broken video-agent marker')
    return null
  }
}

// ───── the token's identity ─────

/** Who comments as this token: GET /user for a PAT; GITHUB_TOKEN can't call it (403), so github-actions[bot]. */
export async function identity(gh: GitHub): Promise<string> {
  try {
    return (await gh.request<{ login: string }>('GET /user')).data.login
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 401 || e.status === 403)) return 'github-actions[bot]'
    throw e
  }
}

export interface OwnComment {
  id: number
  body: string
  marker: Marker | null
}

/** The action's own sticky comment on a PR: the newest comment by the token's identity that carries a marker. */
export async function findOwnComment(
  gh: GitHub,
  pr: number,
  me: string,
  log: Log,
): Promise<OwnComment | null> {
  let found: OwnComment | null = null
  for await (const c of gh.paginate<{ id: number; body: string | null; user: { login: string } | null }>(
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    { path: { issue_number: pr } },
  )) {
    if (c.user?.login !== me || !c.body || !MARKER.test(c.body)) continue
    // Lists are oldest first; the newest marked comment wins.
    found = { id: c.id, body: c.body, marker: parseMarker(c.body, log) }
  }
  return found
}

// ───── lookup ─────

/** Oldest first: createdAt, then id (both racers in 1.5b order videos the same way). */
export const older = (a: Video, b: Video) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** Every video of this account whose some version's prompt ends with the target's exact reference line, oldest first. */
export async function lookupAll(va: VideoAgent, target: RefTarget): Promise<Video[]> {
  const q = refFor(target)
  const found: Video[] = []
  let cursor: string | undefined
  do {
    const page = await va.videos.list({ owner: 'me', q, limit: 50, ...(cursor ? { cursor } : {}) })
    for (const v of page.items) if (v.versions.some((x) => endsWithRef(x.prompt, target))) found.push(v)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return found.sort(older)
}

/** The target's video: the marker's, if it still exists, else the oldest reference match, else null. */
export async function findVideo(
  va: VideoAgent,
  target: RefTarget,
  marker: Marker | null,
  log: Log,
): Promise<Video | null> {
  if (marker) {
    const v = await va.videos.get(marker.videoId).catch(() => null)
    if (v) {
      log.line({ lookup: 'marker', video: v.id })
      return v
    }
  }
  const all = await lookupAll(va, target)
  const chosen = all[0] ?? null
  log.line({ lookup: chosen ? 'reference' : 'none', candidates: all.length, video: chosen?.id })
  return chosen
}

export const latest = (v: Video): Version | undefined => v.versions.find((x) => x.n === v.latestVersion)
export const latestReady = (v: Video): Version | undefined =>
  [...v.versions].sort((a, b) => b.n - a.n).find((x) => x.status === 'ready')
