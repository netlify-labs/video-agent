// Spike S12 (plan 2026-11-02-record-your-own-voiceover §6.2, §6.3, §9): render qualification.
//   npx tsx docs/spikes/s12/render.ts [--case bus90|bus600|automation|remux|hold|all|<comma list>] [--out /tmp/va-s12]
//        [--quality standard] [--size 1920x1080] [--seconds <override bus length>] [--render-deadline-min 20]
// Builds minimal editing-contract compositions in a temp dir (root, back-to-back beats on track 0, a background layer
// on track 1, audio with ids) and renders them with `hyperframes render --quality <q> --output <file>` from the
// composition dir, as scripts/render-job.ts does, after `hyperframes check`.
//   bus90/bus600  a full-length narration bus (24 kHz mono PCM16, 1 kHz beeps at known times + silence) as
//                 <audio id="va-narration" data-va-layer="narration" data-track-index="4">, plus a music bed ducked
//                 by data-automation around each beep. The bus is restored from a content-addressed store by sha256
//                 first (the "reference entry" path). Checks: durations, beep onsets in the decoded AAC vs the bus
//                 (within 1 frame), loudness.
//   automation    music-only, volume lanes of 100/400/600 points shaped so a truncated or ignored lane is audible;
//                 fits measured levels to "full", "first 512 points" and "base volume", and collects any warning text.
//   remux         master gain on the summed mix by re-encoding only the audio stream (video copied), to −14 LUFS
//                 bounded by −1 dBTP; re-measures, checks video packets are byte-identical and beeps still land.
//   hold          base (3 beats) vs two held variants (last beat extended / appended data-va-hold beat with the last
//                 frame as an image); frame-prefix invariance on pre-encode PNG frames and on decoded MP4 frames.
// Progress: JSON lines on stderr. Summary: one JSON block between ===S12-JSON=== lines, also <out>/summary-<cases>.json.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, arch, platform, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import {
  db,
  decodeMono,
  ffmpeg,
  log,
  loudness,
  metrics,
  parseFlags,
  printSummary,
  probe,
  quantile,
  repoRoot,
  rms,
  round,
  runGroup,
  sha256File,
  tool,
  writeWav,
  type GroupResult,
} from '../lib/proc.js'

const flags = parseFlags(process.argv.slice(2))
const outDir = flags.out ?? join(tmpdir(), 'va-s12')
const quality = flags.quality ?? 'standard'
const [W, H] = (flags.size ?? '1920x1080').split('x').map(Number) as [number, number]
const FPS = 30
const FRAME = 1 / FPS
const renderDeadlineMs = Number(flags['render-deadline-min'] ?? 20) * 60_000
const ALL = ['bus90', 'automation', 'remux', 'hold', 'bus600']
const cases = !flags.case || flags.case === 'all' ? ALL : flags.case.split(',')
const BUS_RATE = 24_000
const MUSIC_RATE = 48_000
const hfBin = join(repoRoot, 'node_modules', '.bin', 'hyperframes')
const hf = existsSync(hfBin) ? { cmd: hfBin, pre: [] as string[] } : { cmd: 'npx', pre: ['-y', 'hyperframes'] }
mkdirSync(outDir, { recursive: true })
const started = Date.now()

const errorOf = (e: unknown) => (e instanceof Error ? e.message.slice(0, 1500) : String(e))
const firstLine = (cmd: string, args: string[]) => {
  try {
    return tool(cmd, args).split('\n')[0]?.trim() ?? null
  } catch {
    return null
  }
}

// ---------- Signals ----------

interface Beep {
  t: number
}
/** Beeps at known, deliberately non-periodic times (so nothing locks onto a period). */
function beepTimes(seconds: number): Beep[] {
  const out: Beep[] = []
  for (let k = 0; ; k++) {
    const t = round(1.0 + k * 7.3 + ((k * 5) % 3) * 0.173, 3)
    if (t > seconds - 1) break
    out.push({ t })
  }
  return out
}

/** 1 kHz, 120 ms bursts at −12 dBFS with 5 ms raised-cosine edges; silence elsewhere. Exact sample count. */
function busWav(seconds: number, beeps: Beep[]): Int16Array {
  const s = new Int16Array(Math.round(seconds * BUS_RATE))
  const len = Math.round(0.12 * BUS_RATE)
  const ramp = Math.round(0.005 * BUS_RATE)
  const amp = 32767 * 10 ** (-12 / 20)
  for (const { t } of beeps) {
    const at = Math.round(t * BUS_RATE)
    for (let i = 0; i < len && at + i < s.length; i++) {
      const edge = Math.min(1, i / ramp, (len - 1 - i) / ramp)
      const env = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, edge))
      s[at + i] = Math.round(amp * env * Math.sin((2 * Math.PI * 1000 * i) / BUS_RATE))
    }
  }
  return s
}

/** A steady bed: sines at the given Hz (pure, so a level is easy to read back), −12 dBFS total. */
function musicWav(seconds: number, hz: number[]): Int16Array {
  const s = new Int16Array(Math.round(seconds * MUSIC_RATE))
  const amp = (32767 * 10 ** (-12 / 20)) / hz.length
  for (let i = 0; i < s.length; i++) {
    let v = 0
    for (const f of hz) v += Math.sin((2 * Math.PI * f * i) / MUSIC_RATE)
    s[i] = Math.round(amp * v)
  }
  return s
}

interface Point {
  t: number
  v: number
}
const automationAttr = (points: Point[]) =>
  JSON.stringify({ version: 1, lanes: [{ target: 'volume', points }] })

/** Gain of a lane at t (linear between points; first/last values held, as the mixing reference says). */
function laneAt(points: Point[], t: number): number {
  if (!points.length) return 1
  if (t <= points[0]!.t) return points[0]!.v
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    if (t <= b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
  }
  return points.at(-1)!.v
}

// ---------- Compositions ----------

interface CompSpec {
  dir: string
  seconds: number
  /** `anim`: length of the beat's own animation (default its duration); a held beat keeps the original length. */
  beats: { id: string; start: number; duration: number; authored?: number; anim?: number; hold?: boolean; image?: string }[]
  narration?: string
  music?: { file: string; volume: number; automation?: Point[] }
}

function writeComp(spec: CompSpec) {
  rmSync(spec.dir, { recursive: true, force: true })
  mkdirSync(join(spec.dir, 'vendor'), { recursive: true })
  for (const f of ['gsap.min.js', 'va-contract.js'])
    copyFileSync(join(repoRoot, 'video', 'vendor', f), join(spec.dir, 'vendor', f))
  for (const f of ['hyperframes.json', 'meta.json']) copyFileSync(join(repoRoot, 'video', f), join(spec.dir, f))
  const D = spec.seconds
  const beats = spec.beats
    .map((b) => {
      const label = b.hold ? 'Hold' : `Beat ${b.id}`
      const body = b.image
        ? `<img data-va-media="${b.id}-still" data-va-kind="image" data-va-label="Held frame" src="${b.image}" style="position:absolute;inset:0;width:100%;height:100%" alt="" />`
        : `<div class="card"><h1 class="title" data-va-text="${b.id}-title" data-va-label="Headline">${label}</h1></div>
        <div class="bar" data-va-text="${b.id}-bar" data-va-label="Progress"></div>`
      // Fixed-length animations, so a longer beat holds its last state (va-contract's outer.set at the end).
      const script = b.image
        ? ''
        : `<script>
          vaBeat('${b.id}', (tl, el) => {
            tl.fromTo(el.querySelector('[data-va-text="${b.id}-title"]'), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.4 }, 0)
              .fromTo(el.querySelector('[data-va-text="${b.id}-bar"]'), { scaleX: 0 }, { scaleX: 1, duration: ${Math.min(b.anim ?? b.authored ?? b.duration, 10)}, ease: 'none' }, 0)
          })
        </script>`
      return `<section id="b-${b.id}" class="clip beat" data-va-beat="${b.id}" data-composition-id="${b.id}" data-va-label="${label}" data-start="${b.start}" data-duration="${b.duration}" data-va-authored-duration="${b.authored ?? b.duration}" data-track-index="0"${b.hold ? ' data-va-hold="1"' : ''}>
        ${body}
        ${script}
      </section>`
    })
    .join('\n      ')
  const narration = spec.narration
    ? `<audio id="va-narration" data-va-layer="narration" data-va-audio="narration" data-va-label="Narration" data-track-index="4" data-start="0" data-duration="${D}" data-volume="1" src="${spec.narration}"></audio>`
    : ''
  const music = spec.music
    ? `<audio id="music" data-va-layer="music" data-va-label="Music" data-track-index="2" data-start="0" data-duration="${D}" data-volume="${spec.music.volume}"${spec.music.automation ? ` data-automation='${automationAttr(spec.music.automation)}'` : ''} src="${spec.music.file}"></audio>`
    : ''
  writeFileSync(
    join(spec.dir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="vendor/gsap.min.js"></script>
    <script src="vendor/va-contract.js"></script>
    <style>
      #root { --va-color-bg: #0b0d10; --va-color-text: #f4f5f7; --va-color-accent: #14b8a6; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #0b0d10; }
      #root { width: 100%; height: 100%; position: relative; font-family: system-ui, sans-serif; background: var(--va-color-bg); }
      .layer { position: absolute; inset: 0; background: var(--va-color-bg); }
      .beat { position: absolute; inset: 0; }
      .card { position: absolute; inset: 0; display: grid; place-items: center; }
      .title { color: var(--va-color-text); font-size: ${Math.round(H / 11)}px; font-weight: 700; }
      .bar { position: absolute; left: 0; bottom: 0; width: 100%; height: ${Math.round(H / 60)}px; background: var(--va-color-accent); transform-origin: 0 50%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-va-contract="1" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}" data-fps="${FPS}">
      <div id="bg" class="clip layer" data-va-layer="background" data-va-label="Background" data-track-index="1" data-start="0" data-duration="${D}"></div>
      ${beats}
      ${narration}
      ${music}
    </div>
    <script>
      window.__timelines['main'] = gsap.timeline({ paused: true })
    </script>
  </body>
</html>
`,
  )
}

const beatsOf = (seconds: number, len: number) =>
  Array.from({ length: Math.ceil(seconds / len - 1e-9) }, (_, i) => ({
    id: `b${i + 1}`,
    start: round(i * len),
    duration: round(Math.min(len, seconds - i * len)),
  }))

// ---------- hyperframes ----------

const WARN = /automation|expression limit|base volume|degrad|exceed|truncat/i
const warnings = (r: GroupResult) =>
  [...new Set(`${r.stdout}\n${r.stderrTail}`.split('\n').filter((l) => WARN.test(l) && !l.includes(outDir) && !/^\s*\[INFO\]/.test(l)))].map((l) => l.trim().slice(0, 400))

async function check(dir: string) {
  const r = await runGroup('check', hf.cmd, [...hf.pre, 'check'], { cwd: dir, deadlineMs: 10 * 60_000 })
  const errors = Number(/(\d+) error\(s\)/.exec(`${r.stdout}${r.stderrTail}`)?.[1] ?? 'NaN')
  const lines = `${r.stdout}\n${r.stderrTail}`.split('\n').filter((l) => /[✗⚠]|error|warning/i.test(l)).map((l) => l.trim()).filter(Boolean)
  return { ok: r.ok, wallMs: r.wallMs, errors, findings: [...new Set(lines)].slice(0, 20), automationWarnings: warnings(r) }
}

async function render(dir: string, output: string, extra: string[] = []) {
  const r = await runGroup('render', hf.cmd, [...hf.pre, 'render', '--quality', quality, '--output', output, ...extra], {
    cwd: dir,
    deadlineMs: renderDeadlineMs,
  })
  const text = `${r.stdout}\n${r.stderrTail}`
  const phases = /screenshot capture[^\n]*|[a-z-]+ capture ·[^\n]*/.exec(text)?.[0]?.trim() ?? null
  const renderedIn = Number(/rendered in ([\d.]+)s/.exec(text)?.[1] ?? 'NaN')
  return { result: r, summary: { ...metrics(r), renderedInS: renderedIn, phases, automationWarnings: warnings(r) } }
}

// ---------- Measurements ----------

/** First 1 ms frame within ±0.25 s of each expected time where the 1 kHz band reaches half the window's peak. */
function onsets(path: string, expected: Beep[], stream = 'a:0'): (number | null)[] {
  const rate = 24_000
  const { samples } = decodeMono(path, rate, 'bandpass=f=1000:width_type=q:w=4', stream)
  const hop = Math.round(0.001 * rate)
  return expected.map(({ t }) => {
    const a = Math.max(0, Math.round((t - 0.25) * rate))
    const b = Math.min(samples.length, Math.round((t + 0.25) * rate))
    const env: number[] = []
    for (let i = a; i < b; i += hop) env.push(rms(samples, i, i + hop))
    const peak = Math.max(0, ...env)
    if (peak < 10 ** (-50 / 20)) return null
    const k = env.findIndex((e) => e >= peak / 2)
    return (a + k * hop) / rate
  })
}

function beepCheck(file: string, reference: string, beeps: Beep[]) {
  const ref = onsets(reference, beeps)
  const got = onsets(file, beeps)
  const errs: number[] = []
  let missing = 0
  got.forEach((g, i) => {
    const r = ref[i]
    if (g === null || r === null || r === undefined) missing++
    else errs.push(g - r)
  })
  const abs = errs.map(Math.abs)
  const ms = (x: number | null) => (x === null ? null : round(x * 1000, 1))
  return {
    beeps: beeps.length,
    missing,
    medianSignedMs: ms(quantile(errs, 0.5)),
    medianAbsMs: ms(quantile(abs, 0.5)),
    p95AbsMs: ms(quantile(abs, 0.95)),
    maxAbsMs: ms(abs.length ? Math.max(...abs) : null),
    firstMs: ms(errs[0] ?? null),
    lastMs: ms(errs.at(-1) ?? null),
    withinOneFrame: missing === 0 && abs.every((e) => e <= FRAME),
  }
}

function streams(file: string) {
  const p = probe(file)
  const v = p.streams?.find((s) => s.codec_type === 'video')
  const a = p.streams?.find((s) => s.codec_type === 'audio')
  return {
    bytes: Number(p.format?.size),
    formatDurationS: Number(p.format?.duration),
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, durationS: Number(v.duration), frames: Number(v.nb_frames), rate: v.r_frame_rate } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), durationS: Number(a.duration), bitRate: Number(a.bit_rate), startTime: Number(a.start_time) } : null,
  }
}

/** Per-packet md5 of a stream copied without decoding (pts, dts, size, hash per packet). */
const packetHashes = (file: string, stream: string) =>
  ffmpeg(['-loglevel', 'error', '-i', file, '-map', `0:${stream}`, '-c', 'copy', '-f', 'framemd5', '-'])
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
/** md5 of each decoded frame's pixels. */
const frameHashes = (input: string[], stream = 'v:0') =>
  ffmpeg(['-loglevel', 'error', ...input, '-map', `0:${stream}`, '-f', 'framemd5', '-'])
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').at(-1)!.trim())

// ---------- Cases ----------

const summary: Record<string, unknown> = {}

async function busCase(name: string, seconds: number) {
  const dir = join(outDir, name)
  const comp = join(dir, 'comp')
  const beeps = beepTimes(seconds)
  // The bus lives in a content-addressed store and is restored by sha256 (prototype of the bundle reference entry).
  const store = join(outDir, 'store')
  mkdirSync(store, { recursive: true })
  const tmp = join(dir, 'bus.wav')
  mkdirSync(dir, { recursive: true })
  writeWav(tmp, { rate: BUS_RATE, samples: busWav(seconds, beeps) })
  const busSha = sha256File(tmp)
  copyFileSync(tmp, join(store, `${busSha}.wav`))
  const duck: Point[] = [{ t: 0, v: 1 }]
  for (const { t } of beeps) duck.push({ t: round(t - 0.3), v: 1 }, { t: round(t - 0.1), v: 0.3 }, { t: round(t + 0.25), v: 0.3 }, { t: round(t + 0.5), v: 1 })
  writeComp({
    dir: comp,
    seconds,
    beats: beatsOf(seconds, 10),
    narration: 'assets/narration/bus.wav',
    music: { file: 'assets/media/music.wav', volume: 0.5, automation: duck },
  })
  mkdirSync(join(comp, 'assets', 'media'), { recursive: true })
  writeWav(join(comp, 'assets', 'media', 'music.wav'), { rate: MUSIC_RATE, samples: musicWav(seconds, [220, 330]) })
  let t = Date.now()
  mkdirSync(join(comp, 'assets', 'narration'), { recursive: true })
  const restored = join(comp, 'assets', 'narration', 'bus.wav')
  copyFileSync(join(store, `${busSha}.wav`), restored)
  const restoreOk = sha256File(restored) === busSha
  const restore = { sha256: busSha, bytes: Number(probe(restored).format?.size), ok: restoreOk, ms: Date.now() - t, overTarLimit: Number(probe(restored).format?.size) > 10 * 1024 * 1024 }
  log(`${name}.restore`, restore)
  const checked = await check(comp)
  log(`${name}.check`, checked)
  const video = join(dir, 'video.mp4')
  t = Date.now()
  const { result, summary: rendered } = await render(comp, video)
  log(`${name}.render`, rendered)
  const out: Record<string, unknown> = { seconds, beeps: beeps.length, automationPoints: duck.length, restore, check: checked, render: rendered }
  if (result.ok && existsSync(video)) {
    const s = streams(video)
    out.output = s
    out.durationOk = {
      video: Math.abs((s.video?.durationS ?? 0) - seconds) <= FRAME,
      audio: Math.abs((s.audio?.durationS ?? 0) - seconds) <= 0.05,
      frames: s.video?.frames === Math.round(seconds * FPS),
    }
    out.beeps = { count: beeps.length, ...beepCheck(video, restored, beeps) }
    out.loudness = loudness(video)
  }
  out.pass = Boolean(result.ok && (out.beeps as { withinOneFrame?: boolean } | undefined)?.withinOneFrame && restoreOk)
  log(`${name}.done`, { pass: out.pass, ms: Date.now() - t })
  return out
}

async function automationCase() {
  const D = 40
  const rows: Record<string, unknown>[] = []
  for (const n of [100, 400, 600]) {
    const dir = join(outDir, `lane-${n}`)
    const comp = join(dir, 'comp')
    // Blocks of 2 s alternating 1.0/0.25 up to 80 %, 1.0 to 90 %, then 0.05: a lane cut at 512 points holds 1.0 to the
    // end, and a lane ignored altogether plays everything at the base volume.
    const f = (t: number) => (t >= 0.9 * D ? 0.05 : t >= 0.8 * D ? 1 : Math.floor(t / 2) % 2 ? 0.25 : 1)
    const points = Array.from({ length: n }, (_, i) => {
      const t = round((i * D) / (n - 1), 4)
      return { t, v: f(t) }
    })
    writeComp({ dir: comp, seconds: D, beats: beatsOf(D, 10), music: { file: 'assets/media/music.wav', volume: 1, automation: points } })
    mkdirSync(join(comp, 'assets', 'media'), { recursive: true })
    writeWav(join(comp, 'assets', 'media', 'music.wav'), { rate: MUSIC_RATE, samples: musicWav(D, [220]) })
    const checked = await check(comp)
    const video = join(dir, 'video.mp4')
    const { result, summary: rendered } = await render(comp, video)
    const row: Record<string, unknown> = { points: n, check: checked, render: rendered }
    if (result.ok && existsSync(video)) {
      const { samples, rate } = decodeMono(video, 24_000)
      const win = 0.25
      const models: Record<string, (t: number) => number> = {
        full: (t) => laneAt(points, t),
        first512: (t) => laneAt(points.slice(0, 512), t),
        baseVolume: () => 1,
      }
      const measured: { t: number; dB: number }[] = []
      for (let t = 0.5; t + win <= D - 0.5; t += win) {
        // Only windows where the full lane is constant (so interpolation shape doesn't matter).
        const g0 = models.full!(t)
        if (Math.abs(models.full!(t + win) - g0) > 1e-6 || Math.abs(models.full!(t + win / 2) - g0) > 1e-6) continue
        measured.push({ t, dB: db(rms(samples, Math.round(t * rate), Math.round((t + win) * rate))) })
      }
      // Reference level: windows where every model expects 1.0 in the first 80 %.
      const refs = measured.filter((m) => m.t < 0.8 * D && models.full!(m.t) === 1).map((m) => m.dB)
      const ref = quantile(refs, 0.5) ?? 0
      const fit: Record<string, number | null> = {}
      for (const [name, g] of Object.entries(models)) {
        const errs = measured.map((m) => Math.abs(m.dB - ref - db(g(m.t))))
        fit[name] = quantile(errs, 0.5) === null ? null : round(quantile(errs, 0.9)!, 2)
      }
      const best = Object.entries(fit).sort((a, b) => (a[1] ?? 99) - (b[1] ?? 99))[0]?.[0]
      const tail = measured.filter((m) => m.t >= 0.9 * D + 0.5).map((m) => m.dB - ref)
      const quiet = measured.filter((m) => m.t < 0.8 * D && models.full!(m.t) === 0.25).map((m) => m.dB - ref)
      row.levels = {
        p90AbsErrDbByModel: fit,
        bestFit: best,
        tailRelDb: round(quantile(tail, 0.5) ?? NaN, 2),
        expectedTailRelDb: round(db(0.05), 2),
        quietBlockRelDb: round(quantile(quiet, 0.5) ?? NaN, 2),
        expectedQuietRelDb: round(db(0.25), 2),
        windows: measured.length,
      }
      row.honored = best === 'full' && (fit.full ?? 99) < 1.5
    }
    rows.push(row)
    log('automation.run', row)
  }
  const fitOf = (n: number) => (rows.find((r) => r.points === n)?.levels as { bestFit?: string } | undefined)?.bestFit ?? null
  const warned = rows.some((r) => (r.render as { automationWarnings: string[] }).automationWarnings.length > 0)
  return {
    seconds: D,
    verdict: { fit100: fitOf(100), fit400: fitOf(400), fit600: fitOf(600), anyWarningText: warned },
    pass: fitOf(100) === 'full' && fitOf(400) === 'full',
    runs: rows,
    capFromSource: 'hyperframes 0.8.222 runtime: points.slice(0, 512) per lane (silent), mixer falls back to base volume with "Volume automation exceeded this ffmpeg build\'s expression limits; rendered at base volume"' }
}

async function remuxCase(bus: Record<string, unknown> | undefined) {
  const dir = join(outDir, 'bus90')
  const video = join(dir, 'video.mp4')
  if (!existsSync(video) || !bus) {
    summary.bus90 ??= await busCase('bus90', Number(flags.seconds ?? 90))
  }
  if (!existsSync(video)) return { pass: false, error: 'bus90 render missing' }
  const before = loudness(video)
  const st = streams(video)
  const TARGET = -14
  const CEIL = -1
  let gain = TARGET - before.lufs
  const peakBound = CEIL - 0.2 - before.truePeakDb
  const peakLimited = gain > peakBound
  if (peakLimited) gain = peakBound
  const mastered = join(dir, 'mastered.mp4')
  const remux = (g: number, out: string) => {
    const t = Date.now()
    ffmpeg([
      '-loglevel', 'error', '-y', '-i', video, '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '0',
      '-c:v', 'copy', '-af', `volume=${round(g, 2)}dB`, '-c:a', 'aac',
      '-b:a', String(st.audio?.bitRate && st.audio.bitRate > 0 ? st.audio.bitRate : 192_000),
      '-ar', String(st.audio?.sampleRate || 48_000), '-movflags', '+faststart', out,
    ])
    return Date.now() - t
  }
  let ms = remux(gain, mastered)
  let after = loudness(mastered)
  let passes = 1
  if (after.truePeakDb > CEIL) {
    gain -= after.truePeakDb - CEIL + 0.1
    ms += remux(gain, mastered)
    after = loudness(mastered)
    passes++
  }
  const vBefore = packetHashes(video, 'v:0')
  const vAfter = packetHashes(mastered, 'v:0')
  const identical = vBefore.length === vAfter.length && vBefore.every((l, i) => l === vAfter[i])
  const restored = join(dir, 'comp', 'assets', 'narration', 'bus.wav')
  const beeps = beepTimes(Number(flags.seconds ?? 90))
  const out = {
    before,
    gainDb: round(gain, 2),
    peakLimited,
    passes,
    remuxMs: ms,
    after,
    targetMet: Math.abs(after.lufs - TARGET) <= 1 && after.truePeakDb <= CEIL,
    peakOk: after.truePeakDb <= CEIL,
    videoPacketsIdentical: identical,
    videoPackets: vBefore.length,
    streamsBefore: st,
    streamsAfter: streams(mastered),
    beepsAfter: beepCheck(mastered, restored, beeps),
  }
  return { ...out, pass: identical && out.peakOk && out.beepsAfter.withinOneFrame }
}

async function holdCase() {
  const dir = join(outDir, 'hold')
  mkdirSync(dir, { recursive: true })
  const base = { seconds: 6, beats: beatsOf(6, 2) }
  const HOLD = 2
  const baseFrames = base.seconds * FPS
  const variants: Record<string, CompSpec> = {
    base: { dir: join(dir, 'base'), ...base },
    extend: {
      dir: join(dir, 'extend'),
      seconds: base.seconds + HOLD,
      beats: base.beats.map((b, i, all) => (i === all.length - 1 ? { ...b, duration: b.duration + HOLD, authored: b.duration + HOLD, anim: b.duration } : b)),
    },
    beat: {
      dir: join(dir, 'beat'),
      seconds: base.seconds + HOLD,
      beats: [...base.beats, { id: 'hold', start: base.seconds, duration: HOLD, hold: true, image: 'assets/hold/last.png' }],
    },
  }
  const out: Record<string, unknown> = { baseSeconds: base.seconds, holdSeconds: HOLD, fps: FPS }
  const renders: Record<string, { mp4: string; png: string; render: unknown; renderPng: unknown }> = {}
  for (const [name, spec] of Object.entries(variants)) {
    writeComp(spec)
    if (name === 'beat') {
      // The held image is the base's last pre-encode frame.
      const pngs = listPngs(renders.base!.png)
      mkdirSync(join(spec.dir, 'assets', 'hold'), { recursive: true })
      copyFileSync(pngs.at(-1)!, join(spec.dir, 'assets', 'hold', 'last.png'))
    }
    const checked = name === 'base' ? await check(spec.dir) : null
    const mp4 = join(dir, `${name}.mp4`)
    const png = join(dir, `${name}-png`)
    rmSync(png, { recursive: true, force: true })
    const r1 = await render(spec.dir, mp4)
    const r2 = await render(spec.dir, png, ['--format', 'png-sequence'])
    renders[name] = { mp4, png, render: r1.summary, renderPng: r2.summary }
    log('hold.render', { variant: name, check: checked, mp4: r1.summary.ok, png: r2.summary.ok })
  }
  const baseP = listPngs(renders.base!.png)
  const pixel = (files: string[]) => files.map((f) => frameHashes(['-i', f])[0] ?? '')
  const basePix = pixel(baseP)
  const baseDec = frameHashes(['-i', renders.base!.mp4])
  out.baseFrames = { png: baseP.length, mp4: baseDec.length, expected: baseFrames }
  for (const name of ['extend', 'beat']) {
    const r = renders[name]!
    const p = listPngs(r.png)
    const pix = pixel(p)
    const prefixPre = commonPrefix(basePix, pix)
    const dec = frameHashes(['-i', r.mp4])
    const prefixEnc = commonPrefix(baseDec, dec)
    // PSNR of the shared prefix on encoded frames (inf = identical).
    const psnr = ffmpeg(['-i', renders.base!.mp4, '-i', r.mp4, '-lavfi', `[1:v]trim=end_frame=${baseFrames},setpts=PTS-STARTPTS[h];[0:v][h]psnr`, '-f', 'null', '-'])
    const lastBase = basePix.at(-1)
    const held = pix.slice(baseFrames)
    const heldPsnr = p[baseFrames] && baseP.at(-1)
      ? (/average:([\d.inf]+)/.exec(ffmpeg(['-i', baseP.at(-1)!, '-i', p[baseFrames], '-lavfi', 'psnr', '-f', 'null', '-']))?.[1] ?? null)
      : null
    out[name] = {
      frames: { png: p.length, mp4: dec.length, expected: baseFrames + HOLD * FPS },
      preEncode: { identicalPrefix: prefixPre, of: baseFrames, invariant: prefixPre >= baseFrames },
      encoded: { identicalPrefix: prefixEnc, of: baseFrames, invariant: prefixEnc >= baseFrames, prefixPsnr: /average:([\d.inf]+)/.exec(psnr)?.[1] ?? null, minPsnr: /min:([\d.inf]+)/.exec(psnr)?.[1] ?? null },
      heldFramesEqualLastBase: held.length > 0 && held.every((h) => h === lastBase),
      heldFirstVsLastBasePsnr: heldPsnr,
      render: r.render,
      renderPng: r.renderPng,
    }
  }
  out.base = { render: renders.base!.render, renderPng: renders.base!.renderPng }
  const pre = (k: string) => (out[k] as { preEncode: { invariant: boolean } }).preEncode.invariant
  return { ...out, pass: pre('extend') && pre('beat') }
}

const listPngs = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.png'))
        .sort()
        .map((f) => join(dir, f))
    : []
const commonPrefix = (a: string[], b: string[]) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

// ---------- Main ----------

summary.host = {
  platform: platform(),
  arch: arch(),
  cpus: availableParallelism(),
  memGb: round(totalmem() / 2 ** 30, 1),
  node: process.version,
  ffmpeg: firstLine('ffmpeg', ['-version']),
  hyperframes: firstLine(hf.cmd, [...hf.pre, '--version']),
  quality,
  size: `${W}x${H}`,
}
log('host', summary.host as Record<string, unknown>)
for (const c of cases) {
  const t = Date.now()
  try {
    if (c === 'bus90') summary.bus90 = await busCase('bus90', Number(flags.seconds ?? 90))
    else if (c === 'bus600') summary.bus600 = await busCase('bus600', Number(flags.seconds ?? 600))
    else if (c === 'automation') summary.automation = await automationCase()
    else if (c === 'remux') summary.remux = await remuxCase(summary.bus90 as Record<string, unknown> | undefined)
    else if (c === 'hold') summary.hold = await holdCase()
    else summary[c] = { error: 'unknown case' }
  } catch (e) {
    summary[c] = { error: errorOf(e) }
  }
  log(`case.done`, { case: c, ms: Date.now() - t, pass: (summary[c] as { pass?: unknown } | undefined)?.pass })
}
printSummary('S12-JSON', join(outDir, `summary-${cases.join('-')}.json`), {
  spike: 'S12',
  harness: 1,
  startedAt: new Date(started).toISOString(),
  cases,
  ...summary,
  totalMs: Date.now() - started,
})
