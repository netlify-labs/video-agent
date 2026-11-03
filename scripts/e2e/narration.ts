// Phase-2 live gate for recorded voice-over: upload -> keep-visuals render (plan 2026-11-02 §9 phase 2, §10 Live
// gates; bead va-2qq.3.20). Spends credits: 2 keep-visuals renders by default (about 34 credits each), 4 more with
// LONG=1. MAX_CREDITS (default 250) stops it before any render that would take the projected total past it.
//
//   npx tsx scripts/e2e/narration.ts --dry       # checks the env and local tools, prints the steps and credits; no network
//   npx tsx scripts/e2e/narration.ts --selftest  # runs the analysis on a local ffmpeg stand-in render; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [VIDEO_ID=vid_…] [VIDEO_AGENT_KEY_R=nva_…] \
//     [MAX_CREDITS=250] [VIDEO_PUBLISH_OK=1] npx tsx scripts/e2e/narration.ts
//   LONG=1 LONG_VIDEO_IDS=vid_…,vid_… [LONG_MINUTES=4,10] … npx tsx scripts/e2e/narration.ts   # adds the long-bus runs
//
// VIDEO_AGENT_KEY owns VIDEO_ID (default: its newest ready video with an editable version, at least 9 s long). The
// renders add versions to that video. VIDEO_AGENT_KEY_R (a Reviewer) adds the raw-take checks on the new version.
//
// The fixture is built here: the speech of FIXTURE (default test/fixtures/narration/punch-loud.wav, macOS `say`, "Then
// select deploys, and press the button to publish.") converted by ffmpeg to 24 kHz mono PCM16, laid out as three
// blocks of [0.3 s silence][100 ms 1 kHz beep][0.3 s silence][the speech, trimmed to 0.2 s before its onset]. Beeps are
// written sample-exact, so their source times are known. It's uploaded as narration-upload and three clips (one per
// block) are placed in a shuffled order (block 3, 1, 2), so a single global offset can't pass the beep check.
// Every other audio track is muted (music and SFX by audio ops, the AI voice by the replace mode, original audio by
// muteAll), so the mix is the narration alone.
//
// Asserts on the render (decoded with ffmpeg from the downloaded MP4):
//   - each clip's beep onset (1 kHz Goertzel envelope, half-power crossing, searched only in that clip's window) is
//     within 1 frame of clip.start + (beep - srcStart);
//   - integrated loudness -14 ± 1 LUFS and true peak <= -1 dBTP (ebur128 on the decoded AAC);
//   - captions: status ok; for each clip, its first narration cue starts within CAPTION_TOL_MS (default 200) of the
//     speech onset (VAD on the fixture). S11 measured Parakeet's phrase starts at a 34-48 ms median error once its
//     fixed 240 ms lead is removed (docs/spikes.md S11); 200 ms also covers the VAD's 20 ms frames and `say` onsets;
//   - transcript.txt has the fixture's words; narration.mp3 is an MP3 as long as the video;
//   - visuals: FRAMES (default 12) frames decoded at the same frame-centre times from the base and new MP4 are
//     identical or PSNR >= MIN_PSNR (default 80 dB, S12's floor after H.264). Pre-encode frame hashes aren't reachable
//     from outside (the run report is internal), so this compares encoded frames;
//   - a caption correction (POST /versions/:n/captions) updates the private VTT and transcript links; a stale
//     expectedRev is refused (409). With VIDEO_PUBLISH_OK=1 it publishes the version, checks the public VTT follows a
//     correction, unpublishes, corrects again and checks the public VTT stays gone (no resurrection);
//   - with VIDEO_AGENT_KEY_R: the Reviewer gets 404 on the take and the preview carries no raw take path.
// Then a silence-only take (test/fixtures/narration/silence-only.wav) renders over the new version: ready, captions
// status off or failed, and a valid VTT with no narration cues.
// LONG=1 (expensive): for each of LONG_MINUTES (4 and 10), a take that long (a beep every 30 s with speech after it)
// on a video from LONG_VIDEO_IDS whose length is at least the take minus 120 s (narration past the end holds the last
// frame): render, check every beep within 1 frame and the length, then reopen a draft of that new version, save the
// same narration and render again (the bus at full length again), and check the beeps again.
//
// Cleanup, also on failure: drafts discarded, narration locks released, a publication made here unpublished, the
// uploads removed from the library (the versions keep what they use). Work files go to a temp dir, kept on failure or
// with KEEP_FILES=1. JSON lines per step; the summary has the credits used; exits non-zero on failure.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectSpeech } from '../../src/lib/peaks.js'
import { SAMPLE_RATE } from '../../src/lib/timeline.js'
import { parseVtt } from '../../src/lib/vtt.js'
import { base, key, log, started } from './lib.js'
import {
  call,
  check,
  decodeWav,
  download,
  dry,
  dryRun,
  encodeWav,
  GateError,
  narrationOp,
  openDraft,
  saveDraft,
  sleep,
  uploadRecording,
  type Edit,
  type Media,
} from './narration-lib.js'

const env = process.env
const repo = fileURLToPath(new URL('../../', import.meta.url))
const fixturePath = env.FIXTURE ?? join(repo, 'test/fixtures/narration/punch-loud.wav')
const fixtureText = env.FIXTURE_TEXT ?? 'Then select deploys, and press the button to publish.'
const silencePath = join(repo, 'test/fixtures/narration/silence-only.wav')
const FFMPEG = env.FFMPEG ?? 'ffmpeg'
const FFPROBE = env.FFPROBE ?? 'ffprobe'
const maxCredits = Number(env.MAX_CREDITS ?? 250)
const perRender = Number(env.CREDITS_PER_RENDER ?? 34)
const perLongRender = Number(env.LONG_RENDER_CREDITS ?? 70)
const long = env.LONG === '1'
// FIT=1 runs only the phase-5 gate (bead va-2qq.6.5): one fit-to-narration render, an authoring run.
const fit = env.FIT === '1'
const perFitRender = Number(env.FIT_CREDITS ?? 300)
const longMinutes = (env.LONG_MINUTES ?? '4,10').split(',').map(Number)
const longVideoIds = (env.LONG_VIDEO_IDS ?? '').split(',').filter(Boolean)
const publishOk = env.VIDEO_PUBLISH_OK === '1'
const keyR = env.VIDEO_AGENT_KEY_R ?? ''
const captionTolMs = Number(env.CAPTION_TOL_MS ?? 200)
const minPsnr = Number(env.MIN_PSNR ?? 80)
const frameCount = Number(env.FRAMES ?? 12)
const S = SAMPLE_RATE

const renders = fit
  ? [{ name: 'fit to narration', credits: perFitRender }]
  : [
      { name: 'keep-visuals, 3 clips', credits: perRender },
      { name: 'silence-only take', credits: perRender },
      ...(long
        ? longMinutes.flatMap((m) => [
            { name: `long ${m} min`, credits: perLongRender },
            { name: `long ${m} min reopened`, credits: perLongRender },
          ])
        : []),
    ]
const projected = renders.reduce((a, r) => a + r.credits, 0)

const STEPS = [
  'preflight: A is a Creator; the video (VIDEO_ID or newest ready editable, >= 9 s); ffmpeg/ffprobe; projected credits <= MAX_CREDITS',
  `build the fixture: ${fixturePath} -> 24 kHz mono PCM16 (ffmpeg), 3 blocks with sample-exact 1 kHz beeps`,
  'upload it as narration-upload (upload session, scopeJobId) with peaks + speech spans',
  'open a draft of the editable version, take the narration lock, save 3 clips (shuffled order) + mute music/SFX',
  `render keep_visuals (≈${perRender} credits), wait until ready`,
  'download MP4, VTT, narration.mp3 and transcript.txt (version links) and the base MP4',
  'assert per-clip beeps within 1 frame; -14 ± 1 LUFS, <= -1 dBTP; caption starts within CAPTION_TOL_MS; transcript words; mp3 length',
  `assert FRAMES=${frameCount} frames equal to the base (PSNR >= ${minPsnr} dB)`,
  'caption correction: private VTT + transcript follow; stale expectedRev 409',
  publishOk
    ? 'VIDEO_PUBLISH_OK=1: publish, public VTT follows a correction, unpublish, correct again, public VTT stays 404'
    : 'publish checks skipped (set VIDEO_PUBLISH_OK=1)',
  keyR
    ? 'Reviewer: 404 on the take; preview has no raw take path'
    : 'Reviewer checks skipped (set VIDEO_AGENT_KEY_R)',
  `silence-only take over the new version: render (≈${perRender} credits), captions off/failed, valid empty VTT`,
  long
    ? `LONG=1: ${longMinutes.join(' and ')} min takes on LONG_VIDEO_IDS, render + reopen + re-render each (≈${perLongRender} credits per render)`
    : 'long-bus runs skipped (set LONG=1)',
  'cleanup: discard drafts, release locks, unpublish what was published here, remove the uploads from the library',
]

const tool = (bin: string) => spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0
if (dry)
  dryRun({
    script: 'narration',
    required: { VIDEO_AGENT_URL: env.VIDEO_AGENT_URL, VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY },
    optional: {
      VIDEO_ID: env.VIDEO_ID,
      VIDEO_AGENT_KEY_R: env.VIDEO_AGENT_KEY_R,
      MAX_CREDITS: env.MAX_CREDITS,
      VIDEO_PUBLISH_OK: env.VIDEO_PUBLISH_OK,
      LONG: env.LONG,
      LONG_VIDEO_IDS: env.LONG_VIDEO_IDS,
      LONG_MINUTES: env.LONG_MINUTES,
      FIXTURE: env.FIXTURE,
    },
    steps: STEPS,
    credits: { projected, maxCredits, renders },
    problems: [
      ...(tool(FFMPEG) ? [] : [`${FFMPEG} not found (set FFMPEG)`]),
      ...(tool(FFPROBE) ? [] : [`${FFPROBE} not found (set FFPROBE)`]),
      ...(existsSync(fixturePath) ? [] : [`FIXTURE ${fixturePath} not found`]),
      ...(existsSync(silencePath) ? [] : [`${silencePath} not found`]),
      ...(projected > maxCredits ? [`projected ${projected} credits > MAX_CREDITS ${maxCredits}`] : []),
      ...(long && !longVideoIds.length ? ['LONG=1 needs LONG_VIDEO_IDS'] : []),
      ...(longMinutes.every((m) => m > 0 && m <= 15)
        ? []
        : ['LONG_MINUTES must be minutes between 0 and 15']),
    ],
  })
const selftest = process.argv.includes('--selftest')
if (!selftest && (!base || !key))
  throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY (or pass --dry or --selftest).')
/** Ends a --selftest run through the same summary. */
class SelfTestDone extends Error {}
class FitDone extends Error {}

interface Version {
  n: number
  status: string
  editable: boolean
  mode: string
  editedFromN: number | null
  error: { message: string } | null
  output: { durationSec: number } | null
  usage: { totalCreditsCost?: number } | null
  captions: { status: string; policy: string; rev: number } | null
  links: { video: string; captions: string; narrationAudio?: string; transcript?: string }
  publications: { versionN: number; unpublishedAt: string | null; urls: { captions: string } | null }[]
}
interface Video {
  id: string
  private: boolean
  owner: { id: string }
  latestVersion: number
  versions: Version[]
}

// ───── bookkeeping ─────
const passed: string[] = []
const measured: Record<string, unknown> = {}
const created = { media: [] as string[], drafts: [] as string[], versions: [] as string[] }
const locks = new Set<string>()
const published: { videoId: string; n: number }[] = []
let creditsUsed = 0
let creditsUnknown = 0
const work = mkdtempSync(join(tmpdir(), 'nva-narration-'))
const ok = (name: string, f: Record<string, unknown> = {}) => {
  passed.push(name)
  log('ok', { check: name, ...f })
}

// ───── ffmpeg ─────
function run(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { maxBuffer: 2 ** 30 })
  if (r.status !== 0)
    throw new GateError(`${bin} failed`, { args: args.join(' '), stderr: r.stderr.toString().slice(-800) })
  return { stdout: r.stdout, stderr: r.stderr.toString() }
}
/** Any audio file as 24 kHz mono PCM16 WAV bytes. */
const toTakeWav = (path: string) =>
  new Uint8Array(
    run(FFMPEG, [
      '-v',
      'error',
      '-i',
      path,
      '-map_metadata',
      '-1',
      '-ac',
      '1',
      '-ar',
      String(S),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      '-',
    ]).stdout,
  )
interface Probe {
  streams: {
    codec_type: string
    codec_name: string
    r_frame_rate?: string
    sample_rate?: string
    channels?: number
  }[]
  format: { duration: string }
}
const probe = (path: string) =>
  JSON.parse(
    run(FFPROBE, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      path,
    ]).stdout.toString(),
  ) as Probe
const fpsOf = (p: Probe) => {
  const [a, b] = (p.streams.find((s) => s.codec_type === 'video')?.r_frame_rate ?? '30/1')
    .split('/')
    .map(Number)
  return (a ?? 30) / (b || 1)
}
/** The file's audio, mono f32 at 48 kHz. */
function decodeAudio(path: string) {
  const buf = run(FFMPEG, [
    '-v',
    'error',
    '-i',
    path,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    '-',
  ]).stdout
  const copy = new Uint8Array(buf.byteLength)
  copy.set(buf)
  return { rate: 48000, pcm: new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4)) }
}
function loudness(path: string) {
  const err = run(FFMPEG, [
    '-nostats',
    '-hide_banner',
    '-i',
    path,
    '-vn',
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ]).stderr
  const summary = err.slice(err.lastIndexOf('Summary:'))
  const lufs = Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1] ?? NaN)
  const tp = Number(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1] ?? NaN)
  return { lufs, truePeakDb: tp }
}
function frameAt(path: string, t: number) {
  return run(FFMPEG, [
    '-v',
    'error',
    '-ss',
    t.toFixed(4),
    '-i',
    path,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]).stdout
}
function psnr(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return -1
  let se = 0
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    se += d * d
  }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / a.length))
}

/**
 * The onset of a 1 kHz beep near `expected` (seconds): a 10 ms Goertzel window every 0.5 ms over ±`win`, the first
 * time the power reaches half its peak, less the 2 ms a centred window adds to a step. Local to one window, so each
 * clip is measured on its own.
 */
function beepOnset(pcm: Float32Array, rate: number, expected: number, win = 0.18, freq = 1000) {
  const W = Math.round(0.01 * rate)
  const hop = Math.max(1, Math.round(0.0005 * rate))
  const from = Math.max(0, Math.round((expected - win) * rate))
  const to = Math.min(pcm.length, Math.round((expected + win) * rate))
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / rate)
  const pts: { t: number; p: number }[] = []
  for (let c = from; c + W <= to; c += hop) {
    let s1 = 0
    let s2 = 0
    for (let i = c; i < c + W; i++) {
      const s0 = (pcm[i] ?? 0) + coeff * s1 - s2
      s2 = s1
      s1 = s0
    }
    pts.push({ t: (c + W / 2) / rate, p: s1 * s1 + s2 * s2 - coeff * s1 * s2 })
  }
  const max = Math.max(...pts.map((x) => x.p))
  const sorted = pts.map((x) => x.p).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const hit = pts.find((x) => x.p >= max / 2)
  return {
    onset: hit && max > 0 ? hit.t - 0.207 * (W / rate) : null,
    snrDb: Math.round(10 * Math.log10((max + 1e-12) / (median + 1e-12))),
  }
}
function checkBeeps(label: string, mp4: string, expected: number[], fps: number) {
  const { pcm, rate } = decodeAudio(mp4)
  const frame = 1 / fps
  const rows = expected.map((e, i) => {
    const b = beepOnset(pcm, rate, e)
    return {
      clip: i + 1,
      expected: +e.toFixed(4),
      onset: b.onset === null ? null : +b.onset.toFixed(4),
      errMs: b.onset === null ? null : Math.round((b.onset - e) * 1000),
      snrDb: b.snrDb,
    }
  })
  log('beeps', { label, frameMs: Math.round(frame * 1000), rows })
  const bad = rows.filter((r) => r.onset === null || r.snrDb < 10 || Math.abs(r.onset - r.expected) > frame)
  check(!bad.length, `${label}: every beep within 1 frame`, { bad })
  ok(`${label}: beeps within 1 frame`, {
    beeps: rows.length,
    maxErrMs: Math.max(...rows.map((r) => Math.abs(r.errMs ?? 0))),
  })
  return rows
}

// ───── API ─────
const getVideo = async (id: string) => {
  const r = await call<Video>(key, 'GET', `/api/v1/videos/${id}`)
  check(r.status === 200, 'get video', { id, status: r.status })
  return r.json
}
function guardCredits(next: { name: string; credits: number }) {
  const would = creditsUsed + creditsUnknown * perRender + next.credits
  log('credits_guard', {
    next: next.name,
    used: creditsUsed,
    unknownRuns: creditsUnknown,
    estimate: next.credits,
    would,
    maxCredits,
  })
  check(
    would <= maxCredits,
    `MAX_CREDITS: ${next.name} would take the total to about ${would} (max ${maxCredits})`,
  )
}
async function render(
  videoId: string,
  draft: Edit,
  opts: { holdFinalFrame?: boolean; mode?: 'keep_visuals' | 'fit_to_narration' },
  budget: { name: string; credits: number },
) {
  guardCredits(budget)
  const r = await call<Video>(
    key,
    'POST',
    `/api/v1/edits/${draft.id}/render`,
    {
      mode: opts.mode ?? 'keep_visuals',
      captions: 'sidecar',
      ...(opts.holdFinalFrame ? { holdFinalFrame: true } : {}),
    },
    { 'idempotency-key': crypto.randomUUID() },
  )
  check(r.status === 202, `${budget.name}: render`, { status: r.status, body: r.json })
  const n = r.json.latestVersion
  created.versions.push(`${videoId}#${n}`)
  log('render', { label: budget.name, videoId, n, draftId: draft.id })
  const t0 = Date.now()
  let v: Version | undefined
  for (;;) {
    await sleep(15_000)
    v = (await getVideo(videoId)).versions.find((x) => x.n === n)
    if (v && ['ready', 'failed', 'timed_out', 'cancelled', 'canceled'].includes(v.status)) break
    if (Date.now() - t0 > 60 * 60_000) break
  }
  const credits = v?.usage?.totalCreditsCost
  if (typeof credits === 'number') creditsUsed += credits
  else creditsUnknown++
  log('rendered', {
    label: budget.name,
    n,
    status: v?.status,
    mode: v?.mode,
    sec: Math.round((Date.now() - t0) / 1000),
    credits: credits ?? null,
    creditsUsed,
  })
  check(v?.status === 'ready', `${budget.name}: v${n} should be ready`, {
    status: v?.status,
    error: v?.error,
  })
  const wantMode = opts.mode === 'fit_to_narration' ? 'author' : 'render_unchanged'
  check(v.mode === wantMode, `${budget.name}: the version's mode is ${wantMode}`, { mode: v.mode })
  return v
}
async function fetchTo(url: string, name: string) {
  const r = await download(key, url)
  check(r.status === 200, `download ${name}`, { status: r.status })
  const path = join(work, name)
  writeFileSync(path, r.bytes)
  return { path, bytes: r.bytes, text: new TextDecoder().decode(r.bytes) }
}
const draftOf = (videoId: string, n: number) =>
  openDraft(key, videoId, n, (id) => created.drafts.push(id)).then((d) => {
    locks.add(videoId)
    return d
  })
/** Audio ops muting everything but narration, so the mix (and its measurements) is the narration alone. */
const muteOthers = (d: Edit) =>
  d.composition.audio
    .filter((a) => a.role === 'music' || a.role === 'sfx')
    .map((a) => ({ op: 'audio', id: a.id, muted: true }))

// ───── fixture ─────
const BEEP = Math.round(0.1 * S)
function beep(out: Float32Array, at: number) {
  for (let i = 0; i < BEEP; i++) out[at + i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / S)
}
/** The fixture's speech, from 0.2 s before its VAD onset to 0.3 s after its last span. */
function fixtureSpeech() {
  const pcm = decodeWav(toTakeWav(fixturePath)).samples
  const spans = detectSpeech(pcm)
  check(spans.length > 0, 'the fixture has no speech', { fixturePath })
  const from = Math.max(0, (spans[0]?.[0] ?? 0) - Math.round(0.2 * S))
  const to = Math.min(pcm.length, (spans.at(-1)?.[1] ?? pcm.length) + Math.round(0.3 * S))
  const speech = pcm.subarray(from, to)
  return { speech, onset: (spans[0]?.[0] ?? 0) - from }
}

/** The fixture: three blocks of [0.3 s silence][beep][0.3 s silence][speech], beeps sample-exact. */
function buildFixture() {
  const { speech, onset } = fixtureSpeech()
  const LEAD = Math.round(0.3 * S)
  const GAP = Math.round(0.3 * S)
  const blockLen = LEAD + BEEP + GAP + speech.length
  const pcm = new Float32Array(blockLen * 3)
  const blocks = [0, 1, 2].map((k) => k * blockLen)
  for (const b of blocks) {
    beep(pcm, b + LEAD)
    pcm.set(speech, b + LEAD + BEEP + GAP)
  }
  const wav = encodeWav(pcm)
  const file = join(work, 'fixture.wav')
  writeFileSync(file, wav)
  const fp = probe(file).streams[0]
  check(
    fp?.codec_name === 'pcm_s16le' && fp.sample_rate === String(S) && fp.channels === 1,
    'fixture must be 24 kHz mono PCM16',
    { stream: fp },
  )
  const speechInBlock = LEAD + BEEP + GAP + onset
  log('fixture', {
    file,
    seconds: +(pcm.length / S).toFixed(3),
    blockSec: +(blockLen / S).toFixed(3),
    speechOnsetInBlockSec: +(speechInBlock / S).toFixed(3),
  })
  return { pcm, wav, speech, blocks, blockLen, beepInBlock: LEAD, speechInBlock }
}
type Fixture = ReturnType<typeof buildFixture>

/**
 * Three clips, one per block, in the order block 3, 1, 2, over a video of `D` seconds: each starts 0.1 s into its
 * block (so its beep is 0.2 s in) and is as long as the block or as fits. Where each clip's beep and speech should be.
 */
function placeClips(D: number, mediaId: string, fx: Fixture) {
  const SKIP = Math.round(0.1 * S)
  const SLOT_GAP = Math.round(0.25 * S)
  const budget = Math.floor((D * S - 0.3 * S - 0.5 * S - 2 * SLOT_GAP) / 3)
  const L = Math.min(fx.blockLen - SKIP, budget)
  check(L >= 2.5 * S, 'The video is too short for 3 clips with speech: use one of at least 9 s', {
    durationSec: D,
  })
  const clips = [2, 0, 1].map((k, slot) => ({
    id: `c${k + 1}`,
    mediaId,
    srcStart: (fx.blocks[k] ?? 0) + SKIP,
    srcEnd: (fx.blocks[k] ?? 0) + SKIP + L,
    start: Math.round(0.3 * S) + slot * (L + SLOT_GAP),
  }))
  const speechAt = fx.speechInBlock - SKIP
  return {
    clips,
    L,
    wholeSpeech: L >= fx.blockLen - SKIP,
    beeps: clips.map((c) => (c.start + fx.beepInBlock - SKIP) / S),
    speech: clips.map((c) => (speechAt < L ? (c.start + speechAt) / S : null)),
  }
}
type Placed = ReturnType<typeof placeClips>

/** Each clip's first narration cue against its speech onset. */
function captionRows(vttText: string, p: Placed) {
  const cues = parseVtt(vttText)
  const narrationCues = cues.filter((c) => c.id.startsWith('nc_'))
  const tol = captionTolMs / 1000
  const rows = p.clips.map((c, i) => {
    const want = p.speech[i] ?? null
    const first = narrationCues.find((q) => q.start >= c.start / S - tol && q.start <= (c.start + p.L) / S)
    return {
      clip: c.id,
      expected: want,
      cueStart: first?.start ?? null,
      errMs: want !== null && first ? Math.round((first.start - want) * 1000) : null,
      text: first?.text ?? null,
    }
  })
  log('captions', { cues: cues.length, narrationCues: narrationCues.length, tolMs: captionTolMs, rows })
  const bad = rows.filter(
    (r) => r.expected !== null && (r.errMs === null || Math.abs(r.errMs) > captionTolMs),
  )
  check(
    narrationCues.length > 0 && !bad.length,
    `each clip's first caption within ${captionTolMs} ms of its speech`,
    {
      bad,
    },
  )
  ok('caption timing', { maxErrMs: Math.max(...rows.map((r) => Math.abs(r.errMs ?? 0))) })
  return rows
}

/** FRAMES frames at the same frame-centre times in both files: identical, or PSNR >= MIN_PSNR. */
function compareFrames(basePath: string, newPath: string, fps: number, duration: number) {
  const total = Math.floor(duration * fps)
  const rows: { t: number; exact: boolean; psnr: number }[] = []
  for (let k = 0; k < frameCount; k++) {
    const t = (Math.floor((k * (total - 1)) / Math.max(1, frameCount - 1)) + 0.5) / fps
    const p = psnr(frameAt(basePath, t), frameAt(newPath, t))
    rows.push({ t: +t.toFixed(3), exact: p === Infinity, psnr: p === Infinity ? 999 : +p.toFixed(1) })
  }
  log('frames', { minPsnr, rows })
  check(
    rows.every((r) => r.psnr >= minPsnr),
    `every sampled frame should match the base (PSNR >= ${minPsnr} dB)`,
    { rows: rows.filter((r) => r.psnr < minPsnr) },
  )
  ok('visual frames', { exact: rows.filter((r) => r.exact).length, of: rows.length })
  return rows
}

/**
 * --selftest (no network, no credits): the analysis on a local stand-in for a render. The fixture's clips are mixed
 * as the op places them, encoded with ffmpeg over a test pattern (AAC, -14 LUFS by a measured gain under a -2 dBTP
 * limiter), and checked like a real render against the same pattern without audio; captions are checked on cues
 * written 100 ms after each clip's speech onset.
 */
function selfTest() {
  const D = 16
  const fx = buildFixture()
  const placed = placeClips(D, 'med_selftest0000', fx)
  const mix = new Float32Array(D * S)
  for (const c of placed.clips) mix.set(fx.pcm.subarray(c.srcStart, c.srcEnd), c.start)
  const mixFile = join(work, 'selftest-mix.wav')
  writeFileSync(mixFile, encodeWav(mix))
  const pre = loudness(mixFile)
  const gain = (-14 - pre.lufs).toFixed(2)
  const pattern = ['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${D}`]
  const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads', '1']
  const newMp4 = join(work, 'selftest-new.mp4')
  const baseMp4 = join(work, 'selftest-base.mp4')
  run(FFMPEG, [
    '-v',
    'error',
    '-y',
    ...pattern,
    '-i',
    mixFile,
    '-af',
    `volume=${gain}dB,alimiter=limit=0.79:level=false:latency=1`,
    ...h264,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    newMp4,
  ])
  run(FFMPEG, ['-v', 'error', '-y', ...pattern, ...h264, '-an', baseMp4])
  const fps = fpsOf(probe(newMp4))
  checkBeeps('selftest', newMp4, placed.beeps, fps)
  const loud = loudness(newMp4)
  log('loudness', { ...loud, note: 'a stand-in mix: reported, not asserted' })
  check(Number.isFinite(loud.lufs) && Number.isFinite(loud.truePeakDb), 'ebur128 summary parsed', loud)
  ok('ebur128 parsed', loud)
  const vtt = [
    'WEBVTT',
    '',
    ...placed.clips.flatMap((c, i) => {
      const t = (placed.speech[i] ?? c.start / S) + 0.1
      const ts = (x: number) => `00:00:${x.toFixed(3).padStart(6, '0')}`
      return [`nc_selftest${i}`, `${ts(t)} --> ${ts(t + 1.5)}`, fixtureText, '']
    }),
  ].join('\n')
  captionRows(vtt, placed)
  compareFrames(baseMp4, newMp4, fps, Number(probe(baseMp4).format.duration))
}

let failure: Error | null = null
try {
  if (selftest) {
    selfTest()
    throw new SelfTestDone()
  }
  // ── preflight ──
  const me = (await call<{ id: string; role: string }>(key, 'GET', '/api/v1/me')).json
  check(me.role === 'creator' || me.role === 'admin', 'VIDEO_AGENT_KEY must be a Creator (or admin)', {
    role: me.role,
  })
  check(tool(FFMPEG) && tool(FFPROBE), 'ffmpeg and ffprobe are needed (set FFMPEG / FFPROBE)')
  check(projected <= maxCredits, `projected ${projected} credits > MAX_CREDITS ${maxCredits}`, { renders })
  log('plan', { projected, maxCredits, renders })
  let video: Video | undefined
  if (env.VIDEO_ID) video = await getVideo(env.VIDEO_ID)
  else
    video = (
      await call<{ items: Video[] }>(key, 'GET', '/api/v1/videos?owner=me&status=ready&limit=20')
    ).json.items.find((v) => v.versions.some((x) => x.editable && (x.output?.durationSec ?? 0) >= 9))
  check(!!video, 'No ready editable video of at least 9 s owned by this key (set VIDEO_ID)')
  const vid = video
  check(vid.owner.id === me.id, 'The video must be owned by VIDEO_AGENT_KEY', { owner: vid.owner.id })
  const baseV = vid.versions.find((x) => x.editable)
  check(!!baseV, 'The video has no editable version', { videoId: vid.id })
  const bv = baseV
  log('video', { videoId: vid.id, n: bv.n, durationSec: bv.output?.durationSec, private: vid.private })

  // ── fixture ──
  const fx = buildFixture()
  const upload = await uploadRecording(key, fx.wav, {
    filename: `e2e-narration-${Date.now().toString(36)}.wav`,
    role: 'narration-upload',
    scopeJobId: vid.id,
    step: 'upload',
  })
  created.media.push(upload.id)

  // ── FIT=1: the phase-5 gate ──
  if (fit) {
    // Narration about 20% longer than the visuals: whole fixture blocks back to back, each with its beep, so the
    // fitted video's audio can be checked sample by sample against where the narration was placed.
    const fd = await draftOf(vid.id, bv.n)
    const D = fd.composition.duration
    const SKIP = Math.round(0.1 * S)
    const GAP = Math.round(0.25 * S)
    const len = fx.blockLen - SKIP
    const fclips: { id: string; mediaId: string; srcStart: number; srcEnd: number; start: number }[] = []
    for (let i = 0, at = Math.round(0.3 * S); at < 1.2 * D * S; i++, at += len + GAP) {
      const k = i % 3
      fclips.push({
        id: `f${i + 1}`,
        mediaId: upload.id,
        srcStart: (fx.blocks[k] ?? 0) + SKIP,
        srcEnd: (fx.blocks[k] ?? 0) + SKIP + len,
        start: at,
      })
    }
    const end = Math.max(...fclips.map((c) => c.start + (c.srcEnd - c.srcStart))) / S
    const fop = narrationOp(fclips)
    const fs = await saveDraft(key, fd, fd.rev, [fop, ...muteOthers(fd)])
    check(fs.status === 200, 'fit: save the narration draft', { status: fs.status, body: fs.json })
    log('fit_placed', {
      visualsSec: D,
      narrationEndSec: end,
      clips: fclips.length,
      ratio: +(end / D).toFixed(2),
    })
    check(end > D * 1.15, 'fit: the narration should run well past the visuals', { end, D })
    const fv = await render(
      vid.id,
      fs.json,
      { mode: 'fit_to_narration' },
      renders[0] ?? { name: 'fit', credits: perFitRender },
    )
    check(fv.editedFromN === bv.n, 'fit: edited from the base', { editedFromN: fv.editedFromN })
    const fmp4 = await fetchTo(fv.links.video, 'fit.mp4')
    const fp = probe(fmp4.path)
    const ffps = fpsOf(fp)
    const got = Number(fp.format.duration)
    // The frozen target is the narration's end + 0.5 s post-roll in whole frames (plan §6.4).
    const want = Math.ceil((end + 0.5) * ffps) / ffps
    log('fit_length', { want, got, visualsSec: D, fps: ffps })
    check(got >= end, 'fit: the video must not cut the narration off', { got, end })
    check(Math.abs(got - want) <= 2 / ffps + 0.05, 'fit: the beats total the frozen target', { got, want })
    ok('fit: length is the narration end + post-roll', { got, want, visualsSec: D })
    // The narration is locked: each block's beep is where it was placed, to the frame.
    const fbeeps = fclips.map((c) => (c.start + fx.beepInBlock - SKIP) / S)
    checkBeeps('fit', fmp4.path, fbeeps, ffps)
    const fvtt = await fetchTo(fv.links.captions, 'fit.vtt')
    const fcues = parseVtt(fvtt.text).filter((c) => c.id.startsWith('nc_'))
    check(fcues.length > 0, 'fit: narration captions', { cues: fcues.length, status: fv.captions })
    ok('fit: captions from the narration', { cues: fcues.length })
    throw new FitDone()
  }

  // ── draft: 3 clips, shuffled ──
  const d = await draftOf(vid.id, bv.n)
  const placed = placeClips(d.composition.duration, upload.id, fx)
  const { clips, L } = placed
  const op = narrationOp(clips)
  const saved = await saveDraft(key, d, d.rev, [op, ...muteOthers(d)])
  check(saved.status === 200, 'save the narration draft', { status: saved.status, body: saved.json })
  log('placed', {
    clips: clips.map((c) => ({
      id: c.id,
      startSec: c.start / S,
      srcStartSec: c.srcStart / S,
      lenSec: L / S,
    })),
    muted: muteOthers(d).length,
  })

  // ── render 1 ──
  const v1 = await render(vid.id, saved.json, {}, renders[0] ?? { name: 'keep-visuals', credits: perRender })
  check(v1.editedFromN === bv.n, 'the render should be edited from the base', { editedFromN: v1.editedFromN })
  check(
    !!v1.links.narrationAudio && !!v1.links.transcript,
    'the version should link narration.mp3 and transcript.txt',
    { links: v1.links },
  )
  const mp4 = await fetchTo(v1.links.video, 'new.mp4')
  const baseMp4 = await fetchTo(bv.links.video, 'base.mp4')
  const vtt = await fetchTo(v1.links.captions, 'captions.vtt')
  const mp3 = await fetchTo(v1.links.narrationAudio ?? '', 'narration.mp3')
  const transcript = await fetchTo(v1.links.transcript ?? '', 'transcript.txt')
  const pNew = probe(mp4.path)
  const pBase = probe(baseMp4.path)
  const fps = fpsOf(pNew)
  const durNew = Number(pNew.format.duration)
  const durBase = Number(pBase.format.duration)
  log('files', {
    fps,
    durNew,
    durBase,
    mp4: mp4.bytes.byteLength,
    vtt: vtt.bytes.byteLength,
    mp3: mp3.bytes.byteLength,
    transcript: transcript.text.slice(0, 200),
  })

  // beeps, per clip
  measured.beeps = checkBeeps('keep-visuals', mp4.path, placed.beeps, fps)
  // loudness on the decoded AAC
  const loud = loudness(mp4.path)
  measured.loudness = loud
  log('loudness', loud)
  check(Math.abs(loud.lufs + 14) <= 1, 'integrated loudness should be -14 ± 1 LUFS', loud)
  check(loud.truePeakDb <= -1, 'true peak should be <= -1 dBTP', loud)
  ok('loudness', loud)
  // captions
  check(v1.captions?.status === 'ok', 'narration captions should be ok', { captions: v1.captions })
  measured.captions = captionRows(vtt.text, placed)
  const words = fixtureText.toLowerCase().match(/[a-z']{4,}/g) ?? []
  const said = transcript.text.toLowerCase()
  const found = words.filter((w) => said.includes(w))
  const { wholeSpeech } = placed
  check(
    said.trim().length > 0 && (!wholeSpeech || found.length >= Math.ceil(words.length * 0.6)),
    'transcript.txt should have the fixture’s words',
    { words, found, transcript: transcript.text.slice(0, 300) },
  )
  ok('transcript', { found: found.length, of: words.length })
  const pm = probe(mp3.path)
  check(
    pm.streams[0]?.codec_name === 'mp3' && Math.abs(Number(pm.format.duration) - durNew) <= 0.15,
    'narration.mp3 should be an MP3 as long as the video',
    { codec: pm.streams[0]?.codec_name, mp3: pm.format.duration, mp4: durNew },
  )
  ok('narration.mp3')

  // visuals
  check(Math.abs(durNew - durBase) <= 1 / fps + 0.001, 'keep-visuals should keep the length', {
    durNew,
    durBase,
  })
  measured.frames = compareFrames(baseMp4.path, mp4.path, fps, durBase)

  // caption correction
  const correct = async (n: number, suffix: string) => {
    const v = (await getVideo(vid.id)).versions.find((x) => x.n === n)
    const cur = parseVtt((await fetchTo(v?.links.captions ?? '', `captions-${suffix}.vtt`)).text)
    const target = cur.findIndex((c) => c.id.startsWith('nc_'))
    check(target >= 0 && !!v?.captions, 'a narration cue to correct')
    const next = cur.map((c, i) => ({
      id: c.id,
      start: c.start,
      end: c.end,
      text: i === target ? `${c.text} (${suffix})` : c.text,
    }))
    const r = await call<{ rev: number }>(key, 'POST', `/api/v1/videos/${vid.id}/versions/${n}/captions`, {
      expectedRev: v.captions.rev,
      cues: next,
    })
    check(r.status === 200 && r.json.rev === v.captions.rev + 1, `caption correction ${suffix}`, {
      status: r.status,
      body: r.json,
    })
    log('corrected', { n, suffix, rev: r.json.rev })
    return { fromRev: v.captions.rev, cues: next }
  }
  const c1 = await correct(v1.n, 'corrected')
  const after = (await getVideo(vid.id)).versions.find((x) => x.n === v1.n)
  const vtt2 = await fetchTo(after?.links.captions ?? '', 'captions-after.vtt')
  const tr2 = await fetchTo(after?.links.transcript ?? '', 'transcript-after.txt')
  check(
    vtt2.text.includes('(corrected)') && tr2.text.includes('(corrected)'),
    'the private VTT and transcript should follow the correction',
    { vtt: vtt2.text.slice(0, 300) },
  )
  const stale = await call(key, 'POST', `/api/v1/videos/${vid.id}/versions/${v1.n}/captions`, {
    expectedRev: c1.fromRev,
    cues: c1.cues,
  })
  check(stale.status === 409, 'a stale expectedRev should be refused', { status: stale.status })
  ok('caption correction (private)', { rev: after?.captions?.rev })

  if (publishOk) {
    const pub = await call<{ urls: { captions: string } | null }>(
      key,
      'POST',
      `/api/v1/videos/${vid.id}/versions/${v1.n}/publish`,
      {},
    )
    check(pub.status === 200 && !!pub.json.urls, 'publish the new version', {
      status: pub.status,
      body: pub.json,
    })
    published.push({ videoId: vid.id, n: v1.n })
    const publicVtt = pub.json.urls.captions
    const fetchPublic = async () => {
      const r = await fetch(publicVtt, { cache: 'no-store' })
      return { status: r.status, text: await r.text() }
    }
    const p0 = await fetchPublic()
    check(
      p0.status === 200 && p0.text.includes('(corrected)'),
      'the public VTT should carry the current correction',
      { status: p0.status },
    )
    await correct(v1.n, 'corrected 2')
    let p1 = await fetchPublic()
    for (let i = 0; i < 12 && !p1.text.includes('(corrected 2)'); i++) {
      await sleep(5000)
      p1 = await fetchPublic()
    }
    check(p1.text.includes('(corrected 2)'), 'the public VTT should follow a correction', {
      status: p1.status,
    })
    ok('caption correction (public)')
    const un = await call(key, 'DELETE', `/api/v1/videos/${vid.id}/versions/${v1.n}/publish`)
    check(un.status === 204, 'unpublish', { status: un.status })
    published.pop()
    let p2 = await fetchPublic()
    for (let i = 0; i < 6 && p2.status === 200; i++) {
      await sleep(5000)
      p2 = await fetchPublic()
    }
    check(p2.status !== 200, 'the public VTT should be gone after unpublishing', { status: p2.status })
    await correct(v1.n, 'corrected 3')
    await sleep(20_000)
    const p3 = await fetchPublic()
    check(p3.status !== 200, 'a correction after unpublishing must not bring the public VTT back', {
      status: p3.status,
    })
    ok('no resurrection after unpublish', { status: p3.status })
  } else
    log('skip', {
      check: 'public captions',
      why: 'set VIDEO_PUBLISH_OK=1 to publish the test version (unpublished after)',
    })

  if (keyR) {
    if (vid.private)
      log('skip', { check: 'reviewer raw takes', why: 'the video is private, so the Reviewer cannot see it' })
    else {
      const m = await call(keyR, 'GET', `/api/v1/media/${upload.id}`)
      check(m.status === 404, 'the Reviewer should get 404 on the take', { status: m.status })
      const link = await call<{ url: string }>(
        keyR,
        'GET',
        `/api/v1/videos/${vid.id}/versions/${v1.n}/preview`,
      )
      check(link.status === 200, 'the Reviewer should get a preview link', { status: link.status })
      const html = await (await fetch(link.json.url)).text()
      const paths = [`assets/media/${upload.id}.wav`, `.va-run/narration/src/${upload.id}.wav`]
      const statuses = await Promise.all(
        paths.map(async (p) => (await fetch(new URL(p, link.json.url))).status),
      )
      log('reviewer_preview', { mentionsTake: html.includes(upload.id), paths, statuses })
      check(
        !html.includes(upload.id) && statuses.every((s) => s !== 200),
        'the preview must not carry the raw take',
        { statuses },
      )
      ok('reviewer: no raw take')
    }
  } else log('skip', { check: 'reviewer raw takes', why: 'set VIDEO_AGENT_KEY_R' })

  // ── silence-only take over the new version ──
  check(v1.editable, 'the new version should be editable again')
  const silent = toTakeWav(silencePath)
  const sm = await uploadRecording(key, silent, {
    filename: `e2e-silence-${Date.now().toString(36)}.wav`,
    role: 'narration-upload',
    scopeJobId: vid.id,
    step: 'upload_silence',
  })
  created.media.push(sm.id)
  const d2 = await draftOf(vid.id, v1.n)
  const sLen = decodeWav(silent).samples.length
  const sSaved = await saveDraft(key, d2, d2.rev, [
    narrationOp([{ id: 's1', mediaId: sm.id, srcStart: 0, srcEnd: sLen, start: Math.round(0.5 * S) }]),
    ...muteOthers(d2),
  ])
  check(sSaved.status === 200, 'save the silence-only draft', { status: sSaved.status, body: sSaved.json })
  const v2 = await render(vid.id, sSaved.json, {}, renders[1] ?? { name: 'silence-only', credits: perRender })
  const sv = await fetchTo(v2.links.captions, 'silence.vtt')
  const sCues = parseVtt(sv.text)
  log('silence', { captions: v2.captions, cues: sCues.length, vtt: sv.text.slice(0, 120) })
  // Transcribing silence succeeds and hears nothing: status ok with no cues (off when the track is muted or
  // transcription is turned off). Only a failed transcription would be wrong here.
  check(
    ['ok', 'off'].includes(v2.captions?.status ?? ''),
    'a silence-only take should render with captions ok (nothing heard) or off',
    { captions: v2.captions },
  )
  check(
    sv.text.startsWith('WEBVTT') && !sCues.some((c) => c.id.startsWith('nc_')),
    'a valid VTT with no narration cues',
  )
  ok('silence-only take renders', { n: v2.n, status: v2.captions?.status })

  // ── long buses ──
  if (long) {
    const pool: Video[] = []
    for (const id of longVideoIds) pool.push(await getVideo(id))
    for (const [i, m] of longMinutes.entries()) {
      const sec = m * 60
      const host = pool.find(
        (v) =>
          v.owner.id === me.id &&
          v.versions.some((x) => x.editable && (x.output?.durationSec ?? 0) >= sec - 119),
      )
      check(
        !!host,
        `LONG: no video in LONG_VIDEO_IDS owned by this key with an editable version of at least ${sec - 119} s`,
        { minutes: m },
      )
      const hv = host
      const hb = hv.versions.find((x) => x.editable && (x.output?.durationSec ?? 0) >= sec - 119) as Version
      const lp = new Float32Array(sec * S)
      const beeps: number[] = []
      for (let t = 1; t + 2 < sec; t += 30) {
        beep(lp, t * S)
        beeps.push(t)
        lp.set(
          fx.speech.subarray(0, Math.min(fx.speech.length, (sec - t - 1) * S)),
          Math.round((t + 0.5) * S),
        )
      }
      const lw = encodeWav(lp)
      const lm = await uploadRecording(key, lw, {
        filename: `e2e-long-${m}m-${Date.now().toString(36)}.wav`,
        role: 'narration-upload',
        scopeJobId: hv.id,
        step: `upload_long_${m}m`,
      })
      created.media.push(lm.id)
      const lop = narrationOp([{ id: 'l1', mediaId: lm.id, srcStart: 0, srcEnd: lp.length, start: 0 }])
      const ld = await draftOf(hv.id, hb.n)
      const hold = sec > ld.composition.duration
      const ls = await saveDraft(key, ld, ld.rev, [lop, ...muteOthers(ld)])
      check(ls.status === 200, `LONG ${m} min: save`, { status: ls.status, body: ls.json })
      const lv = await render(
        hv.id,
        ls.json,
        { holdFinalFrame: hold },
        renders[2 + i * 2] ?? { name: `long ${m}`, credits: perLongRender },
      )
      const lmp4 = await fetchTo(lv.links.video, `long-${m}m.mp4`)
      const lpb = probe(lmp4.path)
      const lfps = fpsOf(lpb)
      const want = Math.max(ld.composition.duration, hold ? sec + 0.5 : 0)
      const got = Number(lpb.format.duration)
      log('long', { minutes: m, hold, want, got })
      check(Math.abs(got - want) <= 2 / lfps + 0.05, `LONG ${m} min: length`, { want, got })
      checkBeeps(`long ${m} min`, lmp4.path, beeps, lfps)
      // Reopen the narrated version and render it again with the same narration.
      const rd = await draftOf(hv.id, lv.n)
      const rs = await saveDraft(key, rd, rd.rev, [lop, ...muteOthers(rd)])
      check(rs.status === 200, `LONG ${m} min: save on reopen`, { status: rs.status, body: rs.json })
      const rv = await render(
        hv.id,
        rs.json,
        {},
        renders[3 + i * 2] ?? { name: `long ${m} reopened`, credits: perLongRender },
      )
      const rmp4 = await fetchTo(rv.links.video, `long-${m}m-reopened.mp4`)
      const rp = probe(rmp4.path)
      check(Math.abs(Number(rp.format.duration) - got) <= 1 / lfps + 0.01, `LONG ${m} min: reopened length`, {
        got: rp.format.duration,
        want: got,
      })
      checkBeeps(`long ${m} min reopened`, rmp4.path, beeps, fpsOf(rp))
      ok(`long ${m} min bus`, { first: lv.n, reopened: rv.n })
    }
  }
} catch (e) {
  if (!(e instanceof SelfTestDone) && !(e instanceof FitDone))
    failure = e instanceof Error ? e : new Error(String(e))
} finally {
  try {
    for (const p of published) {
      const r = await call(key, 'DELETE', `/api/v1/videos/${p.videoId}/versions/${p.n}/publish`)
      log('cleanup_unpublish', { ...p, status: r.status })
    }
    for (const d of created.drafts) {
      const r = await call(key, 'DELETE', `/api/v1/edits/${d}`)
      log('cleanup_draft', { draftId: d, status: r.status })
    }
    for (const v of locks) {
      const r = await call(key, 'DELETE', `/api/v1/videos/${v}/narration-lock`)
      log('cleanup_lock', { videoId: v, status: r.status })
    }
    for (const id of created.media) {
      const r = await call<Media>(key, 'DELETE', `/api/v1/media/${id}`)
      log('cleanup_media', {
        mediaId: id,
        status: r.status,
        note: 'out of the library; versions keep what they use',
      })
    }
  } catch (e) {
    log('cleanup_error', { error: String(e) })
  }
  const keep = !!failure || env.KEEP_FILES === '1'
  if (!keep) rmSync(work, { recursive: true, force: true })
  const summary = {
    passed: passed.length,
    checks: passed,
    measured,
    credits: {
      used: Math.round(creditsUsed * 100) / 100,
      unknownRuns: creditsUnknown,
      projected,
      maxCredits,
    },
    created,
    files: keep ? work : null,
    sec: Math.round((Date.now() - started) / 1000),
  }
  if (failure) {
    log('FAIL', { msg: failure.message, ...(failure instanceof GateError ? failure.fields : {}), summary })
    process.exitCode = 1
  } else log('PASS', summary)
}
