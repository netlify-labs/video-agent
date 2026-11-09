// Adds the preview variants (WebP/AVIF posters, hover clip, LQIP) to ready versions rendered before they existed.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… (an admin's) [FFMPEG=/path/to/ffmpeg] [VIDEO_ID=vid_…]
//   [LIMIT=n] [DRY_RUN=1] npx tsx scripts/backfill-previews.ts
// For each ready version missing variants: downloads its MP4, makes the variants locally with the same generator the
// renderer uses, and adds only the missing ones through the admin-only, write-once previews endpoint. Never touches
// the video, poster, GIF, captions or source. Use an ffmpeg with libwebp (ffmpeg-static has it). JSON lines.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreviewFile } from '../app/server/lib/media/previews.js'
import { api, base, fail, key, log } from './e2e/lib.js'
import { makePreviews, posterTime } from './lib/previews.js'

if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY (an admin key).')
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
const only = process.env.VIDEO_ID ?? ''
const limit = Number(process.env.LIMIT ?? Infinity)
const dryRun = process.env.DRY_RUN === '1'

interface Version {
  n: number
  status: string
  output: { durationSec: number } | null
  files: {
    posterSources?: { type: string; srcset: string }[]
    clip?: { type: string }[]
    lqip?: string
  } | null
}
interface Video {
  id: string
  versions: Version[]
}

/** What a version already has, by the names the endpoint takes. */
function present(v: Version): Set<string> {
  const have = new Set<string>()
  for (const s of v.files?.posterSources ?? [])
    for (const [, w] of s.srcset.matchAll(/ (\d+)w\b/g))
      have.add(`poster-${w}.${s.type === 'image/avif' ? 'avif' : 'webp'}`)
  for (const c of v.files?.clip ?? []) have.add(c.type === 'video/webm' ? 'clip.webm' : 'clip.mp4')
  if (v.files?.lqip) have.add('lqip')
  return have
}

async function put(id: string, n: number, name: string, body: Uint8Array) {
  const res = await fetch(`${base}/api/v1/videos/${id}/versions/${n}/previews/${name}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' },
    body,
  })
  // 409: it already has this one (a re-run, or a render that made it), which is fine.
  return res.status
}

const ids: string[] = []
if (only) ids.push(only)
else {
  let cursor: string | null = null
  do {
    const page: { status: number; json: { items: { id: string }[]; nextCursor: string | null } } = await api(
      'GET',
      `/api/v1/videos?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )
    if (page.status !== 200) fail('list failed', { status: page.status })
    ids.push(...page.json.items.map((v) => v.id))
    cursor = page.json.nextCursor
  } while (cursor)
}
log('videos', { count: ids.length, dryRun })

let done = 0
for (const id of ids) {
  const { status, json: video } = await api<Video>('GET', `/api/v1/videos/${id}`)
  if (status !== 200) {
    log('video.skipped', { id, status })
    continue
  }
  for (const v of video.versions) {
    if (done >= limit) break
    if (v.status !== 'ready' || !v.output || !v.files) continue
    const have = present(v)
    if (have.size >= 7) continue
    done++
    if (dryRun) {
      log('version.would_backfill', { id, n: v.n, has: [...have] })
      continue
    }
    const dir = mkdtempSync(join(tmpdir(), 'va-backfill-'))
    try {
      const mp4 = await fetch(`${base}/api/v1/videos/${id}/versions/${v.n}/video`, {
        headers: { authorization: `Bearer ${key}` },
      })
      if (!mp4.ok) {
        log('version.download_failed', { id, n: v.n, status: mp4.status })
        continue
      }
      const video = join(dir, 'video.mp4')
      writeFileSync(video, new Uint8Array(await mp4.arrayBuffer()))
      const durationSec = v.output.durationSec
      const made = makePreviews({ video, out: dir, posterAt: posterTime(durationSec), durationSec, ffmpeg })
      const sent: Record<string, number> = {}
      for (const name of made.files.filter((f: PreviewFile) => !have.has(f)))
        sent[name] = await put(id, v.n, name, new Uint8Array(readFileSync(join(dir, name))))
      if (made.lqip && !have.has('lqip'))
        sent.lqip = await put(id, v.n, 'lqip', new TextEncoder().encode(made.lqip))
      log('version.backfilled', { id, n: v.n, sent, skipped: made.skipped })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
log('done', { versions: done })
