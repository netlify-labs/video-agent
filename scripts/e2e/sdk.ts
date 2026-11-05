// Live check for the SDK against a deployment (cli-and-sdk plan §11 phase 2 gate; bead va-p1th.3.11). Everything goes
// through netlify-video-agent-sdk. Without CREATE_OK=1 it spends no credits; with it, one short video (about
// CREATE_CREDITS = 150). CREDIT_CEILING (default 300) refuses to create once that estimate would pass it.
//
//   npx tsx scripts/e2e/sdk.ts --dry    # checks the env and local tools, prints the steps and credits; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… VIDEO_ID=vid_… [CREATE_OK=1] [CREDIT_CEILING=300] \
//     npx tsx scripts/e2e/sdk.ts
//
// VIDEO_AGENT_KEY is a Creator's or an Admin's key; VIDEO_ID a ready video it can see. Steps, each logged as JSON
// lines (the SDK's request events too, with request ids):
//   1. config: version and features; me.get.
//   2. VIDEO_ID: videos.get, videos.resolve of its web URL, videos.list, the first 3 items of videos.listAll.
//   3. files.url for every file kind the version has; files.download of the MP4 to a temp file, verified with
//      ffprobe (a video stream, a duration) when ffprobe is installed.
//   4. media.upload of a 5 MB file (a padded copy of the downloaded MP4, so it goes through an upload session) to
//      ready, then media.delete in a finally.
//   5. music.search (one query).
//   6. With CREATE_OK=1: videos.create (10 s, silent, with an idempotency key), videos.wait with progress, download
//      and ffprobe the MP4, then videos.delete in a finally.
// Exits non-zero on the first failed check, after cleanup. Work files go to a temp dir, kept on failure.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isVideoAgentError } from '../../packages/sdk/src/index.js'
import { base, key, log, sdk, started } from './lib.js'
import { check, dry, dryRun, GateError } from './narration-lib.js'

const env = process.env
const videoId = env.VIDEO_ID ?? ''
const createOk = env.CREATE_OK === '1'
const ceiling = Number(env.CREDIT_CEILING ?? 300)
const perCreate = Number(env.CREATE_CREDITS ?? 150)
const FFPROBE = env.FFPROBE ?? 'ffprobe'
const tool = (bin: string) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0

const steps = [
  'config (version, features) and me.get',
  'VIDEO_ID: videos.get, videos.resolve(web URL), videos.list, videos.listAll (3 items)',
  `files.url for each file kind; files.download of the MP4${tool(FFPROBE) ? ' verified with ffprobe' : ' (no ffprobe: size only)'}`,
  'media.upload of a 5 MB file through an upload session to ready; media.delete in finally (no credits)',
  'music.search (no credits)',
  createOk
    ? `CREATE_OK: one 10 s silent video (≈${perCreate} credits), wait, download, ffprobe; videos.delete in finally`
    : 'no video created (set CREATE_OK=1 for one ≈150-credit video)',
]
if (dry)
  dryRun({
    script: 'scripts/e2e/sdk.ts',
    required: {
      VIDEO_AGENT_URL: env.VIDEO_AGENT_URL,
      VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY,
      VIDEO_ID: videoId,
    },
    optional: {
      CREATE_OK: env.CREATE_OK,
      CREDIT_CEILING: env.CREDIT_CEILING,
      CREATE_CREDITS: env.CREATE_CREDITS,
    },
    steps,
    credits: { projected: createOk ? perCreate : 0, ceiling, perCreate },
    problems: [
      ...(ceiling > 0 ? [] : ['CREDIT_CEILING must be a positive number']),
      ...(createOk && perCreate > ceiling
        ? [`CREATE_CREDITS ${perCreate} is over CREDIT_CEILING ${ceiling}`]
        : []),
    ],
  })
if (!base || !key || !videoId)
  throw new Error('Set VIDEO_AGENT_URL, VIDEO_AGENT_KEY and VIDEO_ID (or pass --dry).')

const va = sdk()
const work = mkdtempSync(join(tmpdir(), 'va-sdk-e2e-'))
const cleanup: (() => Promise<unknown>)[] = []
let ok = false
let credits = 0

const probe = (path: string) => {
  if (!tool(FFPROBE)) return null
  const r = spawnSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path],
    { encoding: 'utf8' },
  )
  const out = JSON.parse(r.stdout || '{}') as {
    format?: { duration?: string }
    streams?: { codec_type: string }[]
  }
  return {
    duration: Number(out.format?.duration),
    video: Boolean(out.streams?.some((s) => s.codec_type === 'video')),
  }
}

try {
  const config = await va.config.get()
  log('config', { version: config.version, features: config.features })
  const me = await va.me.get()
  log('me', { id: me.id, role: me.role })

  const video = await va.videos.get(videoId)
  const v = video.versions.find((x) => x.n === video.latestVersion)
  check(v?.status === 'ready', 'VIDEO_ID needs a ready latest version', { status: v?.status })
  const resolved = await va.videos.resolve(`${base}/videos/${videoId}`)
  check(resolved.id === videoId, 'resolve(web URL)', { resolved })
  const page = await va.videos.list({ owner: 'all', limit: 2 })
  check(Array.isArray(page.items), 'videos.list')
  const some: string[] = []
  for await (const x of va.videos.listAll({ owner: 'all', limit: 2 })) {
    some.push(x.id)
    if (some.length === 3) break
  }
  log('lists', { firstPage: page.items.length, listAll: some.length })

  for (const file of ['poster', 'gif', 'video', 'captions'] as const) {
    const url = await va.files.url(video, { file })
    check(/^https:\/\//.test(url), `files.url ${file}`, { url: url.slice(0, 60) })
    log('file_url', { file })
  }
  const mp4 = join(work, 'video.mp4')
  const got = await va.files.download(video, { file: 'video', to: mp4 })
  const p = probe(mp4)
  check(got.bytes > 1000 && (!p || (p.video && p.duration > 0)), 'download the MP4', {
    bytes: got.bytes,
    probe: p,
  })
  log('downloaded', { bytes: got.bytes, probe: p })

  // 5 MB: the MP4 padded with a trailing free box, still a valid MP4, so it takes an upload session.
  const clip = new Uint8Array(readFileSync(mp4))
  const big = new Uint8Array(Math.max(5 * 1024 * 1024, clip.byteLength + 8))
  big.set(clip)
  new DataView(big.buffer).setUint32(clip.byteLength, big.byteLength - clip.byteLength)
  big.set(new TextEncoder().encode('free'), clip.byteLength + 4)
  const t = Date.now()
  const item = await va.media.upload(big, {
    filename: `sdk-e2e-${Date.now()}.mp4`,
    caption: 'SDK live check; deleted at the end',
    dedupe: false,
    onProgress: (u) => log('upload', { ...u }),
  })
  cleanup.push(() => va.media.delete(item.id))
  check(item.status === 'ready', 'upload reaches ready', { status: item.status })
  log('uploaded', { mediaId: item.id, bytes: big.byteLength, ms: Date.now() - t })

  const music = await va.music.search({ q: 'ambient piano' })
  log('music', { keys: Object.keys(music) })

  if (createOk) {
    if (credits + perCreate > ceiling)
      throw new GateError('CREDIT_CEILING reached before create', { credits, ceiling })
    const made = await va.videos.create(
      {
        prompt: 'A 10-second title card that says "SDK check" on a plain background.',
        durationSec: 10,
        sound: 'silent',
      },
      { idempotencyKey: `sdk-e2e-${started}` },
    )
    cleanup.push(() => va.videos.delete(made.id))
    log('created', { id: made.id })
    const ready = await va.videos.wait(made.id, { onProgress: (x) => log('progress', { ...x }) })
    const rv = ready.versions.find((x) => x.n === ready.latestVersion)
    credits += rv?.usage?.totalCreditsCost ?? perCreate
    const out = join(work, 'created.mp4')
    const dl = await va.files.download(ready, { file: 'video', to: out })
    const pc = probe(out)
    check(dl.bytes > 1000 && (!pc || pc.video), 'download the new video', { bytes: dl.bytes, probe: pc })
    log('created_ready', { id: made.id, credits: rv?.usage?.totalCreditsCost ?? null, probe: pc })
  }
  ok = true
} catch (e) {
  log('FAIL', {
    msg: e instanceof Error ? e.message : String(e),
    ...(e instanceof GateError ? e.fields : {}),
    ...(isVideoAgentError(e) ? { code: e.code, status: e.status, requestId: e.requestId } : {}),
  })
} finally {
  for (const c of cleanup.reverse())
    await c().then(
      () => log('cleaned'),
      (e: unknown) => log('cleanup_failed', { error: String(e) }),
    )
  if (ok) rmSync(work, { recursive: true, force: true })
  else log('kept', { work })
}
log(ok ? 'PASS' : 'FAILED', { credits, ceiling, sec: Math.round((Date.now() - started) / 1000) })
process.exit(ok ? 0 : 1)
