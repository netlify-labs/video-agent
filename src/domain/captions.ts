// Caption revisions without a render (plan 2026-11-02 §2.6, §6.6 "Caption revisions", bead va-2qq.3.14). A correction
// changes cue text only, keeps every cue's id and timing, and writes new immutable files (captions.r<k>.vtt,
// transcript.r<k>.txt) next to the render's, which stay as they were: the render's hashes are untouched and the
// revision's live in versions.captions. Compare-and-swap on versions.captions.rev; the video's ETag moves.
//
// A published version's mirror (pub/<slug>.json) follows after the commit, with a durable retry: the revision's
// transaction queues a sync_captions work item, the request tries it once, and the sweep retries it until it's done.
// The sync runs under the job's row lock (which unpublishing takes too) and applies only a newer captionsGeneration
// to a mirror that still exists, so a late correction never overwrites a newer one and one after unpublishing (or
// racing it) never brings the mirror back.
import type { Deps } from '../deps.js'
import { sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { transcriptText } from '../lib/narration-captions.js'
import { parseVtt, writeVtt, type VttCue } from '../lib/vtt.js'
import type { Repo } from '../store/types.js'
import { assertCan, type Principal } from './policy.js'
import type { CleanupRow, VersionCaptions, VersionRow } from './types.js'
import { loadJob, pubKey, type PublicationMirror } from './videos.js'

/** The most cues one revision may send (15 minutes of narration is about 300). */
export const MAX_REVISION_CUES = 2000
const MAX_CUE_CHARS = 500
const MAX_CUE_LINES = 3
const SYNC_RETRY_MS = 60_000

export interface CueEdit {
  id: string
  start: number
  end: number
  text: string
}

/** A narration cue (src/lib/narration-captions.ts cueId); the transcript is made of these alone. */
const isNarrationCue = (c: Pick<VttCue, 'id'>) => c.id.startsWith('nc_')

/** Corrected text, made safe: no control characters, no cue-timing arrow, at most 3 trimmed lines. Null if empty. */
export function cleanCueText(text: string): string | null {
  const lines = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/-->/g, '→')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (!lines.length) return null
  const out = lines.slice(0, MAX_CUE_LINES - 1).concat(lines.slice(MAX_CUE_LINES - 1).join(' ') || [])
  return out.join('\n').slice(0, MAX_CUE_CHARS)
}

/** Keys in sorted order at every level: a stored op comes back from jsonb with its keys in any order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/** The narration op's hash (versions.narration.opHash): equal ops, equal hashes, whatever the key order. */
export const narrationOpHash = (op: unknown) => sha256Hex(stableJson(op))

/**
 * Carry-forward (plan §6.6): a new version whose narration op is the same as its base's keeps the base's latest
 * correction, as its own revision 1 (copied, so each version's files stay its own). Null when there's nothing to
 * carry: a different op (it was transcribed again), no correction yet, or a different caption policy.
 */
export async function carriedCaptions(
  deps: Pick<Deps, 'blobs' | 'log'>,
  jobId: string,
  n: number,
  base: Pick<VersionRow, 'n' | 'narration' | 'captions'> | null,
  next: { opHash: string; captions: VersionCaptions },
): Promise<VersionCaptions | null> {
  const from = base?.captions
  if (!base || !from || from.rev === 0 || base.narration?.opHash !== next.opHash) return null
  if (from.policy !== next.captions.policy) return null
  const vtt = await deps.blobs.get('videos', revKey(jobId, base.n, from.files.vtt))
  if (!vtt) return null
  const transcript = from.files.transcript
    ? await deps.blobs.get('videos', revKey(jobId, base.n, from.files.transcript))
    : null
  const files = { vtt: 'captions.r1.vtt', transcript: transcript ? 'transcript.r1.txt' : null }
  await deps.blobs.set('videos', revKey(jobId, n, files.vtt), vtt, {
    contentType: 'text/vtt',
    size: String(vtt.byteLength),
  })
  if (transcript && files.transcript)
    await deps.blobs.set('videos', revKey(jobId, n, files.transcript), transcript, {
      contentType: 'text/plain; charset=utf-8',
      size: String(transcript.byteLength),
    })
  deps.log.info('captions.carried', { jobId, versionN: n, fromN: base.n, fromRev: from.rev })
  return {
    ...next.captions,
    status: from.status,
    rev: 1,
    files,
    sha256: { vtt: sha256Hex(vtt), transcript: transcript ? sha256Hex(transcript) : null },
    generation: 1,
    carriedFrom: { n: base.n, rev: from.rev },
  }
}

const revKey = (jobId: string, n: number, name: string) => `${jobId}/v${n}/${name}`
const syncPrefix = (slug: string, generation: number) => `${pubKey(slug)}#g${generation}`

/**
 * POST /api/v1/videos/:id/versions/:n/captions. Returns the new versions.captions. Owner or admin (the publish power,
 * which a published version's correction needs anyway).
 */
export async function reviseCaptions(
  deps: Deps,
  principal: Principal,
  jobId: string,
  n: number,
  input: { expectedRev: number; cues: CueEdit[] },
): Promise<VersionCaptions> {
  const t0 = Date.now()
  const log = deps.log.child({ jobId, versionN: n })
  const { captions, syncs } = await deps.store.tx(async (repo) => {
    const job = await loadJob(repo, principal, jobId, true)
    assertCan(principal, 'video:rename', { ownerId: job.ownerId })
    const version = await repo.getVersion(jobId, n)
    if (!version || version.status !== 'ready')
      throw new ApiError('not_ready', 'Only ready versions have captions.')
    const pubs = (await repo.listPublications(jobId)).filter((p) => p.versionN === n && !p.unpublishedAt)
    if (pubs.length) assertCan(principal, 'video:publish', { ownerId: job.ownerId })
    const current = version.captions
    if (!current)
      throw new ApiError(
        'conflict',
        "This version's captions come from its render; only narration captions can be corrected.",
      )
    if (current.policy === 'burned')
      throw new ApiError(
        'conflict',
        'These captions are burned into the picture. Edit them in the editor and render again.',
      )
    if (current.rev !== input.expectedRev)
      throw new ApiError('conflict', 'The captions changed since you opened them. Reload and try again.', {
        rev: current.rev,
      })

    const bytes = await deps.blobs.get('videos', revKey(jobId, n, current.files.vtt))
    if (!bytes) throw new ApiError('conflict', "This version's captions file is missing.")
    const existing = parseVtt(new TextDecoder().decode(bytes))
    const next = applyEdits(existing, input.cues)

    const k = current.rev + 1
    const vtt = writeVtt(next)
    const narration = next.filter(isNarrationCue)
    const transcript = narration.length ? transcriptText(narration) : null
    const files = { vtt: `captions.r${k}.vtt`, transcript: transcript ? `transcript.r${k}.txt` : null }
    // New names, so never seen before: written ahead of the commit, and an aborted one is just an unused file (the
    // video's deletion takes its whole prefix).
    await deps.blobs.set('videos', revKey(jobId, n, files.vtt), vtt, {
      contentType: 'text/vtt',
      size: String(new TextEncoder().encode(vtt).byteLength),
    })
    if (transcript && files.transcript)
      await deps.blobs.set('videos', revKey(jobId, n, files.transcript), transcript, {
        contentType: 'text/plain; charset=utf-8',
        size: String(new TextEncoder().encode(transcript).byteLength),
      })
    const captions: VersionCaptions = {
      ...current,
      rev: k,
      files,
      sha256: { vtt: sha256Hex(vtt), transcript: transcript ? sha256Hex(transcript) : null },
      generation: current.generation + 1,
    }
    await repo.updateVersion(jobId, n, { captions })
    // The video's ETag moves, so readers refetch the DTO (and its revision-aware links).
    await repo.updateJob(jobId, { updatedAt: deps.clock.now().toISOString(), version: job.version + 1 })
    const syncs: CleanupRow[] = []
    for (const p of pubs) {
      const row: CleanupRow = {
        id: deps.ids.uuid(),
        kind: 'sync_captions',
        store: 'internal',
        prefix: syncPrefix(p.slug, captions.generation),
        nextActionAt: new Date(deps.clock.now().getTime() + SYNC_RETRY_MS).toISOString(),
        doneAt: null,
      }
      await repo.insertCleanup(row)
      syncs.push(row)
    }
    return { captions, syncs }
  })
  log.info('captions.revised', {
    rev: captions.rev,
    generation: captions.generation,
    cues: input.cues.length,
    published: syncs.length,
    ms: Date.now() - t0,
  })
  // Once now; on failure the sweep retries (runCleanup).
  for (const row of syncs) await runCaptionsSync(deps, row)
  return captions
}

/** The existing cues with the edited text: the same ids in the same order, the same timings. */
function applyEdits(existing: VttCue[], edits: CueEdit[]): VttCue[] {
  if (edits.length !== existing.length)
    throw new ApiError('invalid_request', 'Send every cue, in order: corrections change text only.', {
      expected: existing.length,
    })
  return existing.map((c, i) => {
    const e = edits[i] as CueEdit
    if (e.id !== c.id || Math.abs(e.start - c.start) > 0.0005 || Math.abs(e.end - c.end) > 0.0005)
      throw new ApiError('invalid_request', "A cue's id or timing changed: corrections change text only.", {
        cue: c.id,
      })
    const text = cleanCueText(e.text)
    if (!text) throw new ApiError('invalid_request', 'A cue has no text.', { cue: c.id })
    return { ...c, text }
  })
}

/** One mirror sync work item: true once it's done (applied, or nothing left to apply). Never throws. */
export async function runCaptionsSync(deps: Deps, row: CleanupRow): Promise<boolean> {
  const slug = /^pub\/([a-z2-9]+)\.json#g\d+$/.exec(row.prefix)?.[1]
  try {
    const outcome = slug ? await deps.store.tx((repo) => syncMirror(deps, repo, slug)) : 'gone'
    await deps.store.updateCleanup(row.id, { doneAt: deps.clock.now().toISOString() })
    deps.log.info('captions.mirror_sync', { slug, outcome })
    return true
  } catch (e) {
    deps.log.warn('captions.mirror_sync_failed', { slug, error: e })
    await deps.store.updateCleanup(row.id, {
      nextActionAt: new Date(deps.clock.now().getTime() + SYNC_RETRY_MS).toISOString(),
    })
    return false
  }
}

/**
 * Under the job's row lock: the version's current revision into the mirror, only if the publication is live, its
 * mirror exists and is of an older generation. Returns what happened.
 */
async function syncMirror(
  deps: Pick<Deps, 'blobs'>,
  repo: Repo,
  slug: string,
): Promise<'applied' | 'unpublished' | 'no_mirror' | 'current' | 'gone'> {
  const pub0 = await repo.getPublication(slug)
  if (!pub0) return 'gone'
  await repo.getJob(pub0.jobId, { lock: true })
  // Read again under the lock: unpublishing takes the same lock before it marks the row.
  const pub = await repo.getPublication(slug)
  if (!pub || pub.unpublishedAt) return 'unpublished'
  const captions = (await repo.getVersion(pub.jobId, pub.versionN))?.captions
  if (!captions) return 'gone'
  const raw = await deps.blobs.get('internal', pubKey(slug))
  if (!raw) return 'no_mirror'
  const mirror = JSON.parse(new TextDecoder().decode(raw)) as PublicationMirror
  if ((mirror.captionsGeneration ?? 0) >= captions.generation) return 'current'
  const prefix = `${pub.jobId}/v${pub.versionN}`
  const next: PublicationMirror = {
    ...mirror,
    keys: {
      ...mirror.keys,
      captions: `${prefix}/${captions.files.vtt}`,
      ...(captions.files.transcript ? { transcript: `${prefix}/${captions.files.transcript}` } : {}),
    },
    captionsGeneration: captions.generation,
  }
  await deps.blobs.set('internal', pubKey(slug), JSON.stringify(next))
  return 'applied'
}
