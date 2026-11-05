// Phase 1 gate of screen recordings (screen-recording plan §10; bead va-rsk5.2.12): the library half, live, with no
// credits (no video is made). Run on a deploy preview with ALLOW_NON_PRODUCTION=true, or on production with the
// owner's OK; `--dry` first, which prints the steps and touches nothing.
//
//   npx tsx scripts/e2e/recording-library.ts --dry
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [VIDEO_AGENT_KEY_B=nva_…] [VIDEO_AGENT_KEY_ADMIN=nva_…] \
//     [RECORDING_MB=140] npx tsx scripts/e2e/recording-library.ts [--keep]
//
// VIDEO_AGENT_KEY is Creator A's key (the uploader); VIDEO_AGENT_KEY_B another Creator's, VIDEO_AGENT_KEY_ADMIN an
// admin's (each check is skipped, and says so, without its key). Steps, each logged as one JSON line:
//   1. A normalized RECORDING_MB fixture (ffmpeg testsrc2 2560x1440, 30 fps, -g 30, +faststart, cached under .render/)
//      uploads through an upload session with the screen-recording role (the SDK's upload helper; the feature itself
//      is listed only once phase 2 ships), then its trace (with an email in a button name) is PUT.
//   2. The item is ready, role screen-recording, hasTrace. The assembly function's media.assembly_memory and
//      media.assembly_result lines (rssMb, peak under 700) are read from the function log by hand (printed hint).
//   3. Visibility: B gets 404 for the item and its trace; the admin can read it; A reads the trace back scrubbed.
//   4. The trace is replaced (PUT again, 200); a trace for another file (wrong frame size) gets 400.
//   5. A refused file: a 3 s clip with a 10 s GOP is rejected with the keyframe message.
//   6. The signed file URL serves a Range of the 140 MB item (206, the right bytes).
//   7. Cleanup: the uploads are deleted, even on failure; --keep skips it.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { uploadMedia } from '../../packages/sdk/src/helpers/media.js'
import { isVideoAgentError } from '../../packages/sdk/src/index.js'
import { base, key, log, sdk, started } from './lib.js'
import { call, check, dry, dryRun, GateError } from './narration-lib.js'

const env = process.env
const keyB = env.VIDEO_AGENT_KEY_B ?? ''
const keyAdmin = env.VIDEO_AGENT_KEY_ADMIN ?? ''
const mb = Number(env.RECORDING_MB ?? 140)
const keep = process.argv.includes('--keep')
const FFMPEG = env.FFMPEG ?? 'ffmpeg'
const FFPROBE = env.FFPROBE ?? 'ffprobe'
const has = (bin: string) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0

const steps = [
  `make (or reuse) a ${mb} MB 2560x1440 30 fps recording under .render/recording-library/ and upload it with the screen-recording role, then PUT its trace`,
  'check the item: ready, role screen-recording, hasTrace; print the hint for the assembly memory log lines',
  `visibility: ${keyB ? 'B gets 404 for item and trace' : 'B skipped (no VIDEO_AGENT_KEY_B)'}; ${keyAdmin ? 'admin reads it' : 'admin skipped (no VIDEO_AGENT_KEY_ADMIN)'}; A reads the trace back scrubbed`,
  'replace the trace (200); a trace for another file (400)',
  'a 3 s clip with a 10 s GOP is rejected with the keyframe message',
  'Range request on the signed file URL (206, bytes match)',
  keep ? 'no cleanup (--keep)' : 'cleanup: delete the uploads',
]
if (dry)
  dryRun({
    script: 'scripts/e2e/recording-library.ts',
    required: { VIDEO_AGENT_URL: env.VIDEO_AGENT_URL, VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY },
    optional: { VIDEO_AGENT_KEY_B: keyB, VIDEO_AGENT_KEY_ADMIN: keyAdmin, RECORDING_MB: env.RECORDING_MB },
    steps,
    credits: { projected: 0, note: 'no video is made; uploads only' },
    problems: [
      ...(has(FFMPEG) ? [] : ['ffmpeg is not installed']),
      ...(has(FFPROBE) ? [] : ['ffprobe is not installed']),
      ...(mb > 0 && mb <= 150 ? [] : ['RECORDING_MB must be 1-150']),
    ],
  })
if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY (or pass --dry).')

const dir = join('.render', 'recording-library')
mkdirSync(dir, { recursive: true })
const run = (bin: string, args: string[]) => {
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new GateError(`${bin} failed`, { stderr: r.stderr.slice(-800) })
  return r.stdout
}

/** A normalized recording of about `mb` MB: 4 Mbps of noisy test pattern, so its length is mb * 2 seconds. */
function fixture(): { path: string; seconds: number } {
  const seconds = Math.min(300, Math.round((mb * 8) / 4))
  const path = join(dir, `recording-${mb}mb.mp4`)
  if (!existsSync(path))
    run(FFMPEG, [
      ...[
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=s=2560x1440:r=30:d=${seconds},noise=alls=20:allf=t`,
      ],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '8M'],
      ...[
        '-g',
        '30',
        '-keyint_min',
        '30',
        '-sc_threshold',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        path,
      ],
    ])
  const duration = Number(
    run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]),
  )
  return { path, seconds: duration }
}

/** A 3 s clip with one keyframe every 10 s: refused. */
function badClip() {
  const path = join(dir, 'gop300.mp4')
  if (!existsSync(path))
    run(FFMPEG, [
      ...['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0'],
      ...['-pix_fmt', 'yuv420p', '-movflags', '+faststart', path],
    ])
  return path
}

const trace = (seconds: number, width = 2560, height = 1440) => ({
  v: 1,
  source: { kind: 'script', tool: 'scripts/e2e/recording-library.ts', startedAt: new Date().toISOString() },
  frame: { width, height, fps: 30, duration: seconds },
  viewport: { width: 1280, height: 720, dpr: 2 },
  moves: [
    [0, 0.5, 0.5],
    [1, 0.6, 0.4],
  ],
  events: [
    {
      kind: 'click',
      t: 1.2,
      x: 0.6,
      y: 0.4,
      button: 0,
      target: { role: 'button', name: 'Invite jane@example.com', box: [0.55, 0.35, 0.1, 0.1] },
    },
  ],
  redact: [],
})

const va = sdk()
const send = { send: (x: Parameters<typeof va.send>[0]) => va.send(x), retries: 3 }
const uploaded: string[] = []
let ok = false
try {
  // 1. Upload with the role, then the trace.
  const { path, seconds } = fixture()
  const bytes = new Uint8Array(readFileSync(path))
  log('fixture', { path, bytes: bytes.byteLength, seconds })
  const t0 = Date.now()
  const item = await uploadMedia(send, bytes, {
    filename: 'gate-recording.mp4',
    role: 'screen-recording',
    dedupe: false,
    onProgress: (p) => p.phase !== 'uploading' && log('upload', { ...p }),
  })
  uploaded.push(item.id)
  log('uploaded', { mediaId: item.id, ms: Date.now() - t0, status: item.status })
  const put = await call<{ hasTrace?: boolean }>(key, 'PUT', `/api/v1/media/${item.id}/trace`, trace(seconds))
  check(put.status === 200, 'trace PUT', { status: put.status, body: put.text.slice(0, 400) })

  // 2. The item.
  const got = await call<{ status: string; role: string; hasTrace: boolean }>(
    key,
    'GET',
    `/api/v1/media/${item.id}`,
  )
  check(
    got.json.status === 'ready' && got.json.role === 'screen-recording' && got.json.hasTrace,
    'item ready with role and trace',
    { item: got.json },
  )
  log('memory_hint', {
    read: `netlify logs:function media-assemble-background (or the Functions log in the UI): media.assembly_memory and media.assembly_result for ${item.id}; rssMb must stay under 700`,
  })

  // 3. Visibility.
  if (keyB) {
    for (const p of [`/api/v1/media/${item.id}`, `/api/v1/media/${item.id}/trace`]) {
      const r = await call(keyB, 'GET', p)
      check(r.status === 404, `B gets 404 for ${p}`, { status: r.status })
    }
  } else log('skip', { check: 'visibility for another Creator (no VIDEO_AGENT_KEY_B)' })
  if (keyAdmin) {
    const r = await call(keyAdmin, 'GET', `/api/v1/media/${item.id}`)
    check(r.status === 200, 'admin reads the item', { status: r.status })
  } else log('skip', { check: 'admin read (no VIDEO_AGENT_KEY_ADMIN)' })
  const back = await call<{ events: { target?: { name?: string } }[] }>(
    key,
    'GET',
    `/api/v1/media/${item.id}/trace`,
  )
  check(back.json.events[0]?.target?.name === 'Invite …', 'trace comes back scrubbed', {
    name: back.json.events[0]?.target?.name,
  })

  // 4. Replace, and a trace for another file.
  const again = await call(key, 'PUT', `/api/v1/media/${item.id}/trace`, trace(seconds))
  check(again.status === 200, 'trace replaced', { status: again.status })
  const wrong = await call(key, 'PUT', `/api/v1/media/${item.id}/trace`, trace(seconds, 1920, 1080))
  check(wrong.status === 400, 'a trace for another file is refused', {
    status: wrong.status,
    body: wrong.text.slice(0, 300),
  })

  // 5. A refused file.
  const refused = await uploadMedia(send, new Uint8Array(readFileSync(badClip())), {
    filename: 'gate-gop300.mp4',
    role: 'screen-recording',
    dedupe: false,
  }).then(
    (m) => {
      uploaded.push(m.id)
      return null
    },
    (e: unknown) => e,
  )
  check(
    isVideoAgentError(refused) &&
      refused.code === 'media_rejected' &&
      /keyframe every second/.test(refused.message),
    'long GOP refused with the keyframe message',
    { error: refused instanceof Error ? refused.message : String(refused) },
  )
  const rejectedId = isVideoAgentError(refused)
    ? (refused.details as { mediaId?: string } | undefined)?.mediaId
    : undefined
  if (rejectedId) uploaded.push(rejectedId)

  // 6. Range on the signed file URL.
  const file = (got.json as { urls?: { file?: string } }).urls?.file
  check(typeof file === 'string', 'the item has a signed file URL')
  const range = await fetch(`${base}${file}`, { headers: { range: 'bytes=1000000-1000999' } })
  const slice = new Uint8Array(await range.arrayBuffer())
  check(
    range.status === 206 &&
      Buffer.compare(Buffer.from(slice), Buffer.from(bytes.subarray(1_000_000, 1_001_000))) === 0,
    'Range on the file URL',
    { status: range.status, bytes: slice.byteLength },
  )
  ok = true
} catch (e) {
  log('FAIL', {
    msg: e instanceof Error ? e.message : String(e),
    ...(e instanceof GateError ? e.fields : {}),
  })
} finally {
  if (!keep)
    for (const id of uploaded) {
      const r = await call(key, 'DELETE', `/api/v1/media/${id}`)
      log('cleanup', { mediaId: id, status: r.status })
    }
  log(ok ? 'PASS' : 'FAILED', { seconds: Math.round((Date.now() - started) / 1000) })
  process.exit(ok ? 0 : 1)
}
