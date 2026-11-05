// Fills versions.beats for ready contract-v1 versions made before finalize recorded them (redo a scene, plan §4.2),
// so the scene picker is instant everywhere. Like scripts/backfill-previews.ts, it works through the API with an
// admin's key: GET …/versions/{n}/beats fills and stores a missing list, so this only finds the versions that need it.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… (an admin's) [VIDEO_ID=vid_…] [LIMIT=n] [DRY_RUN=1]
//     npx tsx scripts/backfill-beats.ts
// Safe to re-run: a version that has its beats is skipped. JSON lines, one per version.
import { api, base, key, log } from './e2e/lib.js'

export type Call = (method: string, path: string) => Promise<{ status: number; json: unknown }>

interface Version {
  n: number
  status: string
  editable: boolean
  beats: unknown[] | null
}

export interface BackfillOptions {
  /** Only this video. */
  videoId?: string
  /** At most this many versions filled (or counted, dry). */
  limit?: number
  /** Count and log the versions, change nothing. */
  dryRun?: boolean
  log?: (step: string, f?: Record<string, unknown>) => void
}

/** Fills the beats of every ready, editable version that has none; returns how many it filled (or would). */
export async function backfillBeats(
  call: Call,
  o: BackfillOptions = {},
): Promise<{ filled: number; failed: number }> {
  const say = o.log ?? (() => undefined)
  const limit = o.limit ?? Infinity
  const ids: string[] = []
  if (o.videoId) ids.push(o.videoId)
  else {
    let cursor: string | null = null
    do {
      const page = await call(
        'GET',
        `/api/v1/videos?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      if (page.status !== 200) throw new Error(`Listing videos failed (${page.status}).`)
      const json = page.json as { items: { id: string }[]; nextCursor: string | null }
      ids.push(...json.items.map((v) => v.id))
      cursor = json.nextCursor
    } while (cursor)
  }
  say('videos', { count: ids.length, dryRun: o.dryRun === true })
  let filled = 0
  let failed = 0
  for (const id of ids) {
    const { status, json } = await call('GET', `/api/v1/videos/${id}`)
    if (status !== 200) {
      say('video.skipped', { id, status })
      continue
    }
    for (const v of (json as { versions: Version[] }).versions) {
      if (filled >= limit) break
      // Only editable (contract-v1) versions have scenes; the route answers null for any other.
      if (v.status !== 'ready' || !v.editable || v.beats !== null) continue
      if (o.dryRun) {
        filled++
        say('version.would_fill', { id, n: v.n })
        continue
      }
      const started = Date.now()
      const res = await call('GET', `/api/v1/videos/${id}/versions/${v.n}/beats`)
      const beats = (res.json as { beats?: unknown[] | null }).beats
      if (res.status === 200 && beats) {
        filled++
        say('version.filled', { id, n: v.n, beats: beats.length, ms: Date.now() - started })
      } else {
        failed++
        say('version.not_filled', { id, n: v.n, status: res.status, ms: Date.now() - started })
      }
    }
  }
  say('done', { filled, failed, dryRun: o.dryRun === true })
  return { filled, failed }
}

if (process.argv[1]?.endsWith('backfill-beats.ts')) {
  if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY (an admin key).')
  const { failed } = await backfillBeats((m, p) => api(m, p), {
    ...(process.env.VIDEO_ID ? { videoId: process.env.VIDEO_ID } : {}),
    ...(process.env.LIMIT ? { limit: Number(process.env.LIMIT) } : {}),
    dryRun: process.env.DRY_RUN === '1',
    log,
  })
  if (failed) process.exitCode = 1
}
