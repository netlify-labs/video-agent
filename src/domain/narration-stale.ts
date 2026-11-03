// Stale base (plan 2026-11-02 §2.7): a version newer than a draft's base may have landed with different narration.
// The draft's DTO says so ("Narration changed in v7 (Sam, 10 min ago)") by comparing a stable hash of the base
// version's resolved narration op with the newest ready version's. The editor then offers Rebase onto v7
// (rebaseNarration) or Keep mine, where rendering the draft replaces their narration and the render dialog warns.
import { sha256Hex } from '../lib/crypto.js'
import type { Repo } from '../store/types.js'
import type { EditRow, VersionRow } from './types.js'

export interface NarrationChanged {
  /** The newest ready version, whose narration differs from the draft's base. */
  inVersion: number
  by: { userId: string; name: string }
  at: string
  /** The draft has its own narration: rendering it (Keep mine) replaces v`inVersion`'s. */
  yoursReplaces: boolean
}

/** JSON with keys sorted at every level, so a jsonb round trip (any key order) hashes the same. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`
  if (x && typeof x === 'object')
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(x ?? null)
}

/** A version's resolved narration op (finalize's, else the render's frozen one), or null. */
const narrationOf = (v: Pick<VersionRow, 'narration' | 'frozen'>): unknown =>
  v.narration?.op ?? v.frozen?.narration?.op ?? null

/** The stable hash of a version's resolved narration op; versions without narration all hash alike. */
export const narrationHash = (v: Pick<VersionRow, 'narration' | 'frozen'> | null) =>
  sha256Hex(canonical(v ? narrationOf(v) : null))

/** Whether a newer ready version changed the narration since the draft's base; null when it didn't. */
export async function narrationChangedSince(
  repo: Repo,
  e: Pick<EditRow, 'jobId' | 'baseN' | 'ops'>,
): Promise<NarrationChanged | null> {
  const versions = await repo.listVersions(e.jobId)
  const newest = versions
    .filter((v) => v.status === 'ready' && v.n > e.baseN)
    .reduce<VersionRow | null>((a, v) => (!a || v.n > a.n ? v : a), null)
  if (!newest) return null
  const base = versions.find((v) => v.n === e.baseN) ?? null
  if (narrationHash(base) === narrationHash(newest)) return null
  const author = await repo.getUser(newest.authorId)
  return {
    inVersion: newest.n,
    by: { userId: newest.authorId, name: author?.name ?? author?.email ?? 'Someone' },
    at: newest.createdAt,
    yoursReplaces: (e.ops as { op?: unknown }[]).some((o) => o.op === 'narration'),
  }
}
