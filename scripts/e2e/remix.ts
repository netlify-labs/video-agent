// Live check for remixing (remix spec docs/plans/2026-11-03-remix.md §7 step 5; bead va-p62w.5.1). Spends credits:
// two or three remix runs (about REMIX_CREDITS = 250 each). CREDIT_CEILING (default 600) refuses to start a remix once
// the credits so far (runs without a reported cost counted at REMIX_CREDITS) have reached it.
//
//   npx tsx scripts/e2e/remix.ts --dry    # checks the env and local tools, prints the steps and credits; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… SOURCE_ID=vid_… [SOURCE_VERSION=3] [NARRATED_ID=vid_…] \
//     [NEW_NAME=Orbitly] [NEW_TOPIC=…] [CREDIT_CEILING=600] npx tsx scripts/e2e/remix.ts [--keep]
//
// VIDEO_AGENT_KEY is a Creator's or an Admin's key that can see SOURCE_ID (a ready video that names a product) and
// NARRATED_ID (a ready video with a recorded narration version). Steps, each logged as JSON lines:
//   1. Targeted remix of SOURCE_ID ("swap the product name to NEW_NAME"), with an idempotency key: wait for ready;
//      isRemix, remixOf is the source and version, same aspect; NEW_NAME is in the captions, title or summary; the
//      poster (first frame) is close to the source's: a 64-bit difference hash of each (ffmpeg, 9x8 grey) within
//      POSTER_MAX_DISTANCE bits (default 14). Without ffmpeg, only byte sizes are compared, logged as a weak check.
//   2. New-topic remix of SOURCE_ID ("same format, about NEW_TOPIC"): wait for ready; same aspect; length within
//      DURATION_TOL (default 0.3, at least 3 s) of the source's; the captions' word overlap with the source's
//      (Jaccard over words of 3+ letters) at most CAPTION_MAX_OVERLAP (default 0.5).
//   3. With NARRATED_ID: remix its newest ready version with recorded narration; the remix has none (no
//      links.narrationAudio, captions null: the render's own captions).
//   4. Step 1's request again with the same idempotency key: 202 and the same video id, no new run.
// The summary has each run's credits (usage.totalCreditsCost) and the total. The remixes are deleted at the end
// unless --keep. Work files go to a temp dir, kept on failure or with KEEP_FILES=1. Exits non-zero on failure.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseVtt } from '../../src/lib/vtt.js'
import { base, key, log, started } from './lib.js'
import { call, check, download, dry, dryRun, finish, sleep } from './narration-lib.js'

const env = process.env
const keep = process.argv.includes('--keep')
const FFMPEG = env.FFMPEG ?? 'ffmpeg'
const sourceId = env.SOURCE_ID ?? ''
const sourceVersion = env.SOURCE_VERSION ? Number(env.SOURCE_VERSION) : undefined
const narratedId = env.NARRATED_ID ?? ''
const newName = env.NEW_NAME ?? 'Orbitly'
const newTopic = env.NEW_TOPIC ?? 'image CDN: resizing and optimizing images on the fly with a URL'
const ceiling = Number(env.CREDIT_CEILING ?? 600)
const perRemix = Number(env.REMIX_CREDITS ?? 250)
const posterMaxDistance = Number(env.POSTER_MAX_DISTANCE ?? 14)
const durationTol = Number(env.DURATION_TOL ?? 0.3)
const captionMaxOverlap = Number(env.CAPTION_MAX_OVERLAP ?? 0.5)
const waitMinutes = Number(env.WAIT_MINUTES ?? 30)

const tool = (bin: string) => spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0
const remixes = narratedId ? 3 : 2
const projected = remixes * perRemix

const STEPS = [
  `preflight: SOURCE_ID${sourceVersion ? ` v${sourceVersion}` : ' (latest ready version)'} is ready; its poster and captions`,
  `targeted remix "swap the product name to ${newName}" (≈${perRemix} credits, with an idempotency key): wait ready; isRemix, remixOf, same aspect; ${newName} in captions/title/summary; poster dHash within ${posterMaxDistance} bits of the source's${tool(FFMPEG) ? '' : ' (no ffmpeg: weak byte-size check)'}`,
  `new-topic remix "same format, about ${newTopic}" (≈${perRemix} credits): wait ready; same aspect; length within ${durationTol * 100}% (3 s min); caption word overlap <= ${captionMaxOverlap}`,
  narratedId
    ? `narrated remix of NARRATED_ID's newest ready narrated version (≈${perRemix} credits): no links.narrationAudio, captions null`
    : 'narrated remix skipped (set NARRATED_ID)',
  "replay step 1's request with the same idempotency key: 202, same video id (no credits)",
  `credits: each run's usage.totalCreditsCost and the total; no remix starts once the total reaches CREDIT_CEILING ${ceiling}`,
  keep ? 'keep the remixes (--keep)' : 'delete the remixes (pass --keep to keep them)',
]

if (dry)
  dryRun({
    script: 'remix',
    required: {
      VIDEO_AGENT_URL: env.VIDEO_AGENT_URL,
      VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY,
      SOURCE_ID: sourceId,
    },
    optional: {
      SOURCE_VERSION: env.SOURCE_VERSION,
      NARRATED_ID: narratedId,
      NEW_NAME: env.NEW_NAME,
      NEW_TOPIC: env.NEW_TOPIC,
      CREDIT_CEILING: env.CREDIT_CEILING,
      REMIX_CREDITS: env.REMIX_CREDITS,
      FFMPEG: env.FFMPEG,
    },
    steps: STEPS,
    credits: {
      projected,
      remixes,
      perRemix,
      ceiling,
      note:
        projected > ceiling
          ? `the projection is over the ceiling: a remix is refused once the running total reaches ${ceiling}`
          : 'within the ceiling',
    },
    problems: [
      ...(sourceId && !sourceId.startsWith('vid_') ? ['SOURCE_ID should be a video id (vid_…)'] : []),
      ...(narratedId && !narratedId.startsWith('vid_') ? ['NARRATED_ID should be a video id (vid_…)'] : []),
      ...(sourceVersion !== undefined && !(sourceVersion > 0)
        ? ['SOURCE_VERSION must be a version number']
        : []),
      ...(ceiling > 0 ? [] : ['CREDIT_CEILING must be a positive number']),
    ],
  })
if (!base || !key || !sourceId)
  throw new Error('Set VIDEO_AGENT_URL, VIDEO_AGENT_KEY and SOURCE_ID (or pass --dry).')

interface Version {
  n: number
  status: string
  error: { message: string } | null
  usage: { totalCreditsCost?: number } | null
  output: { durationSec: number; width: number; height: number; title: string; summary: string } | null
  captions: { status: string } | null
  links: { poster: string; captions: string; narrationAudio?: string }
}
interface Video {
  id: string
  title: string
  aspect: string
  private: boolean
  isRemix: boolean
  remixOf: { id: string; n: number; title: string } | null
  versions: Version[]
  error?: { code?: string; message?: string }
}

// ───── bookkeeping ─────
const passed: string[] = []
const runs: { step: string; id: string; status: string | null; credits: number | null; sec: number }[] = []
const created: string[] = []
let creditsUsed = 0
let creditsUnknown = 0
const work = mkdtempSync(join(tmpdir(), 'nva-remix-'))
const ok = (name: string, f: Record<string, unknown> = {}) => {
  passed.push(name)
  log('ok', { check: name, ...f })
}
const running = () => creditsUsed + creditsUnknown * perRemix

// ───── helpers ─────
const getVideo = async (id: string) => {
  const r = await call<Video>(key, 'GET', `/api/v1/videos/${id}`)
  check(r.status === 200, 'get video', { id, status: r.status })
  return r.json
}
async function fetchTo(url: string, name: string) {
  const r = await download(key, url)
  check(r.status === 200, `download ${name}`, { status: r.status })
  const path = join(work, name)
  writeFileSync(path, r.bytes)
  return { path, bytes: r.bytes, text: new TextDecoder().decode(r.bytes) }
}
const captionText = async (v: Version, name: string) =>
  parseVtt((await fetchTo(v.links.captions, name)).text)
    .map((c) => c.text)
    .join(' ')
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [])
function overlap(a: string, b: string) {
  const wa = words(a)
  const wb = words(b)
  const inter = [...wa].filter((w) => wb.has(w)).length
  const union = new Set([...wa, ...wb]).size
  return union ? inter / union : 1
}
/** A 64-bit difference hash: the image at 9x8 grey, one bit per left-to-right brightness step. Null without ffmpeg. */
function dhash(path: string): bigint | null {
  const r = spawnSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      'scale=9:8:flags=area,format=gray',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1 << 20 },
  )
  if (r.status !== 0 || r.stdout.length < 72) return null
  let h = 0n
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const i = y * 9 + x
      h = (h << 1n) | ((r.stdout[i] ?? 0) < (r.stdout[i + 1] ?? 0) ? 1n : 0n)
    }
  return h
}
const hamming = (a: bigint, b: bigint) => (a ^ b).toString(2).replace(/0/g, '').length
const ready = (video: Video, n?: number) =>
  n !== undefined
    ? video.versions.find((v) => v.n === n)
    : [...video.versions].sort((a, b) => b.n - a.n).find((v) => v.status === 'ready')

/** Refuses to start a remix once the running total has reached the ceiling. */
function guardCredits(step: string) {
  const total = running()
  log('credits_guard', { next: step, used: creditsUsed, unknownRuns: creditsUnknown, total, ceiling })
  check(
    total < ceiling,
    `CREDIT_CEILING: ${step} not started, the total is already ${total} (ceiling ${ceiling})`,
  )
}
/** Starts a remix (202 expected) and returns the response; the caller waits for it. */
async function startRemix(step: string, sourceVideoId: string, body: Record<string, unknown>, idem?: string) {
  guardCredits(step)
  const r = await call<Video>(
    key,
    'POST',
    `/api/v1/videos/${sourceVideoId}/remix`,
    body,
    idem ? { 'idempotency-key': idem } : {},
  )
  check(r.status === 202, `${step}: remix`, { status: r.status, body: r.json })
  created.push(r.json.id)
  log('remixed', { step, sourceId: sourceVideoId, id: r.json.id, location: r.headers.get('location') })
  return r.json
}
/** Waits for the remix's v1 to finish, records its credits and requires it ready. */
async function waitReady(step: string, id: string) {
  const t0 = Date.now()
  let last = ''
  let video: Video
  let v: Version | undefined
  for (;;) {
    await sleep(15_000)
    video = await getVideo(id)
    v = video.versions.find((x) => x.n === 1)
    if (v?.status !== last) log('progress', { step, id, status: v?.status })
    last = v?.status ?? ''
    if (v && ['ready', 'failed', 'cancelled', 'timed_out'].includes(v.status)) break
    if (Date.now() - t0 > waitMinutes * 60_000) break
  }
  const credits = v?.usage?.totalCreditsCost
  if (typeof credits === 'number') creditsUsed += credits
  else creditsUnknown++
  const sec = Math.round((Date.now() - t0) / 1000)
  runs.push({ step, id, status: v?.status ?? null, credits: credits ?? null, sec })
  log('run', { step, id, status: v?.status, sec, credits: credits ?? null, total: running() })
  check(v?.status === 'ready', `${step}: the remix should be ready`, {
    id,
    status: v?.status,
    error: v?.error,
  })
  return { video, v1: v }
}

let failure: Error | null = null
try {
  // ───── preflight ─────
  const source = await getVideo(sourceId)
  const sv = ready(source, sourceVersion)
  check(sv?.status === 'ready', 'the source version should be ready', { sourceId, n: sourceVersion ?? null })
  const srcPoster = await fetchTo(sv.links.poster, 'source-poster')
  const srcCaptions = await captionText(sv, 'source.vtt')
  log('source', {
    id: source.id,
    n: sv.n,
    title: source.title,
    aspect: source.aspect,
    private: source.private,
    durationSec: sv.output?.durationSec ?? null,
    posterBytes: srcPoster.bytes.byteLength,
    captionWords: words(srcCaptions).size,
  })

  // ───── 1. targeted remix ─────
  const targeted = {
    prompt: `Keep everything exactly as it is, but swap the product name to "${newName}" everywhere it appears (on-screen text, captions and any voice-over).`,
    fromVersion: sv.n,
  }
  const idem = crypto.randomUUID()
  const r1 = await startRemix('targeted', sourceId, targeted, idem)
  const t = await waitReady('targeted', r1.id)
  check(t.video.isRemix, 'targeted: isRemix', { isRemix: t.video.isRemix })
  check(t.video.remixOf?.id === sourceId && t.video.remixOf.n === sv.n, 'targeted: remixOf is the source', {
    remixOf: t.video.remixOf,
    want: { id: sourceId, n: sv.n },
  })
  check(t.video.aspect === source.aspect, 'targeted: same aspect', {
    got: t.video.aspect,
    want: source.aspect,
  })
  check(t.video.private === source.private, 'targeted: private follows the source', {
    private: t.video.private,
  })
  ok('targeted: provenance', { id: t.video.id, remixOf: t.video.remixOf, aspect: t.video.aspect })
  const tCaptions = await captionText(t.v1, 'targeted.vtt')
  const haystack = `${tCaptions} ${t.video.title} ${t.v1.output?.title ?? ''} ${t.v1.output?.summary ?? ''}`
  check(haystack.toLowerCase().includes(newName.toLowerCase()), `targeted: "${newName}" is in the remix`, {
    title: t.video.title,
    captions: tCaptions.slice(0, 400),
  })
  ok('targeted: new name', { overlapWithSource: +overlap(srcCaptions, tCaptions).toFixed(2) })
  const tPoster = await fetchTo(t.v1.links.poster, 'targeted-poster')
  const ha = dhash(srcPoster.path)
  const hb = dhash(tPoster.path)
  if (ha !== null && hb !== null) {
    const distance = hamming(ha, hb)
    log('poster', { method: 'dhash', distance, max: posterMaxDistance })
    check(distance <= posterMaxDistance, 'targeted: the first frame should look like the source', {
      distance,
      max: posterMaxDistance,
      files: work,
    })
    ok('targeted: poster', { distance })
  } else {
    const ratio = tPoster.bytes.byteLength / Math.max(1, srcPoster.bytes.byteLength)
    log('poster', {
      method: 'bytes',
      weak: true,
      note: 'ffmpeg unavailable: byte sizes only',
      sourceBytes: srcPoster.bytes.byteLength,
      remixBytes: tPoster.bytes.byteLength,
      ratio: +ratio.toFixed(2),
    })
    check(ratio > 0.33 && ratio < 3, 'targeted: the poster size should be close to the source (weak)', {
      ratio,
    })
    ok('targeted: poster (weak)', { ratio: +ratio.toFixed(2) })
  }

  // ───── 2. new-topic remix ─────
  const r2 = await startRemix('new topic', sourceId, {
    prompt: `Same format, style and pacing, but about ${newTopic}. Rewrite the script and on-screen text for the new topic.`,
    fromVersion: sv.n,
  })
  const nt = await waitReady('new topic', r2.id)
  check(nt.video.isRemix && nt.video.remixOf?.id === sourceId, 'new topic: remixOf is the source', {
    remixOf: nt.video.remixOf,
  })
  check(nt.video.aspect === source.aspect, 'new topic: same aspect', { got: nt.video.aspect })
  const want = sv.output?.durationSec ?? 0
  const got = nt.v1.output?.durationSec ?? 0
  const tol = Math.max(3, want * durationTol)
  check(Math.abs(got - want) <= tol, 'new topic: length close to the source', { want, got, tol })
  const ntCaptions = await captionText(nt.v1, 'new-topic.vtt')
  const o = overlap(srcCaptions, ntCaptions)
  log('captions', { overlap: +o.toFixed(2), max: captionMaxOverlap, remix: ntCaptions.slice(0, 300) })
  check(o <= captionMaxOverlap, 'new topic: the captions should differ substantially from the source', {
    overlap: o,
    max: captionMaxOverlap,
  })
  ok('new topic', { id: nt.video.id, durationSec: got, overlap: +o.toFixed(2) })

  // ───── 3. narrated source ─────
  if (narratedId) {
    const narrated = await getVideo(narratedId)
    const nv = [...narrated.versions]
      .sort((a, b) => b.n - a.n)
      .find((v) => v.status === 'ready' && !!v.links.narrationAudio)
    check(!!nv, 'narrated: NARRATED_ID should have a ready version with recorded narration', { narratedId })
    log('narrated_source', { id: narrated.id, n: nv.n, captions: nv.captions?.status ?? null })
    const r3 = await startRemix('narrated', narratedId, {
      prompt: 'Keep everything as it is, but make the end card say "Remixed".',
      fromVersion: nv.n,
    })
    const nr = await waitReady('narrated', r3.id)
    check(!nr.v1.links.narrationAudio, 'narrated: the remix has no recorded narration', {
      links: nr.v1.links,
    })
    check(nr.v1.captions === null, "narrated: the remix's captions are the render's own", {
      captions: nr.v1.captions,
    })
    ok('narrated: narration dropped', { id: nr.video.id, fromN: nv.n })
  } else log('skip', { step: 'narrated', why: 'NARRATED_ID not set' })

  // ───── 4. idempotent replay ─────
  const replay = await call<Video>(key, 'POST', `/api/v1/videos/${sourceId}/remix`, targeted, {
    'idempotency-key': idem,
  })
  check(
    replay.status === 202 && replay.json.id === r1.id,
    'replay: same key and request return the same video',
    {
      status: replay.status,
      got: replay.json.id,
      want: r1.id,
    },
  )
  ok('replay', { id: replay.json.id })
} catch (e) {
  failure = e instanceof Error ? e : new Error(String(e))
} finally {
  if (!keep)
    for (const id of created) {
      const r = await call(key, 'DELETE', `/api/v1/videos/${id}`).catch((e: unknown) => ({
        status: String(e),
      }))
      log('cleanup_delete', { id, status: r.status })
    }
  const keepFiles = !!failure || env.KEEP_FILES === '1'
  if (!keepFiles) rmSync(work, { recursive: true, force: true })
  const summary = {
    passed: passed.length,
    checks: passed,
    credits: {
      runs,
      total: Math.round(creditsUsed * 100) / 100,
      unknownRuns: creditsUnknown,
      ceiling,
    },
    created,
    kept: keep,
    files: keepFiles ? work : null,
    sec: Math.round((Date.now() - started) / 1000),
  }
  finish(failure, summary)
}
