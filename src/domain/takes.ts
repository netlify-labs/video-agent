// Recorded voice-over takes (plan 2026-11-02 §1 goal 5, §2.7, §8): who may read one. A take is a media row with a
// narration role; it's private to its uploader (and admins) until it's used on a video, and then any Creator who can
// read that video can read it too, so teammates can re-cut the narration. Reviewers and Viewers never get raw takes.
import type { Repo } from '../store/types.js'
import { creatorOrUp, type Principal } from './policy.js'
import type { MediaRow } from './types.js'
import { canSee } from './videos.js'

export const isTake = (m: Pick<MediaRow, 'role'>) => m.role !== null

/**
 * The one take-read predicate, used on every path that can expose a take: loadMedia and signed links (mediaDto),
 * library listing and search, the duplicate check and upload finalization. The narration op's resolution and the
 * render snapshot (later beads) must call it too for every new pick. Items that aren't takes keep the library's
 * rules and pass. Callers turn a false into not_found, never forbidden, so a take's existence doesn't leak.
 *
 * Used means a media_refs row puts the take in a version of a video the reader can see, or in a draft of that video
 * written by the take's uploader (someone else's draft doesn't share it). A frozen render attempt doesn't count: its
 * version will. "Can see" is the video's own rule, so private videos stay private.
 */
export async function canReadTake(repo: Repo, p: Principal, m: MediaRow): Promise<boolean> {
  if (!isTake(m) || m.uploaderId === p.userId || p.role === 'admin') return true
  if (!creatorOrUp(p.role)) return false
  for (const r of await repo.listMediaRefsByMedia([m.id])) {
    if (r.ownerKind === 'frozen_attempt') continue
    if (r.ownerKind === 'draft') {
      const e = await repo.getEdit(r.ownerId)
      if (!e || e.authorId !== m.uploaderId || e.jobId !== r.jobId) continue
    }
    const job = await repo.getJob(r.jobId)
    if (job && !job.deletedAt && canSee(p, job)) return true
  }
  return false
}

/** The rows the principal may read, in order (takes they can't read are dropped). */
export async function readableMedia(repo: Repo, p: Principal, rows: MediaRow[]) {
  const ok = await Promise.all(rows.map((m) => canReadTake(repo, p, m)))
  return rows.filter((_, i) => ok[i])
}
