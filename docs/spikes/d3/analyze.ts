// Spike D3 (plan 2026-11-04-screen-recording-demo §5.2, §10 Phase 0 and Time budget): how long recording analysis
// takes on the runner for a 5-minute 1440p recording, in full and from the analysis cache.
//   npx tsx docs/spikes/d3/analyze.ts [--out /tmp/va-d3] [--seconds 300] [--speech kokoro|say|none] [--scdet 10]
//        [--diff-fps 10] [--jobs <n>]
// 1. Fixture: ffmpeg draws a screen-recording-like file (2560x1440, 30 fps, H.264 1 s GOP, ~3.5 Mbps): six 50 s
//    "pages" of panels, a 24 px cursor that moves for 7 s then rests for 5 s (idle), a card flash after each move
//    ("click"), and a speech track (Kokoro phrases on the runner, macOS `say` locally) muxed as AAC. Not timed.
// 2. Full analysis, each stage timed: ffprobe; freezedetect (n=-70dB, d=1.2, 640 wide); scdet (640 wide); the same
//    two in one pass; grey 320-wide frames at 10 fps through Node (neighbour diff, threshold, connected components,
//    bounding boxes, a small-blob cursor track); contact sheets (12 frames per scene, 4x3 tile, 1280 wide, JPEG q80,
//    at most 24); 12 focus crops (full-res frame, crop, 1280 wide); Parakeet install + transcribe of the audio.
//    Writes analysis.json keyed by sha256 + ANALYZER_VERSION.
// 3. Cache hit: sha256, read analysis.json, then only the sheets and crops again.
// JSON lines on stderr, a summary between ===D3-JSON=== lines and in <out>/summary.json. Nothing in the repo is written.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, availableParallelism, platform, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { kokoro, toPcm } from '../../../scripts/lib/voice-providers.js'
import { ffmpeg, log, metrics, parseFlags, printSummary, probe, repoRoot, round, runGroup, sha256File, tool, which, writeWav } from '../lib/proc.js'

const flags = parseFlags(process.argv.slice(2))
const outDir = flags.out ?? join(tmpdir(), 'va-d3')
const SECONDS = Number(flags.seconds ?? 300)
const SPEECH = flags.speech ?? (platform() === 'darwin' ? 'say' : 'kokoro')
const SCDET = Number(flags.scdet ?? 10)
const DIFF_FPS = Number(flags['diff-fps'] ?? 10)
const JOBS = Number(flags.jobs ?? availableParallelism())
const W = 2560
const H = 1440
const FPS = 30
const PAGE_S = 50
const ANALYZER_VERSION = 'd3-proto-1'
const videoDir = join(repoRoot, 'video')
mkdirSync(outDir, { recursive: true })
const started = Date.now()

const timed = async <T>(stage: string, fn: () => T | Promise<T>): Promise<{ ms: number; value: T }> => {
  const t = Date.now()
  const value = await fn()
  const ms = Date.now() - t
  log('stage', { stage, ms })
  return { ms, value }
}

// ---------- 1. Fixture ----------

const PHRASES = [
  'First I open the dashboard and pick the project.',
  'Now I click deploy and wait for the build.',
  'Here the logs stream in, nothing to do yet.',
  'I add a new environment variable for the API key.',
  'Then I save it and trigger a fresh deploy.',
  'The preview link shows the change right away.',
]

async function speechTrack(file: string): Promise<{ engine: string; ms: number; error?: string }> {
  const t = Date.now()
  if (SPEECH === 'none') return { engine: 'none', ms: 0 }
  const dir = join(outDir, 'phrases')
  mkdirSync(dir, { recursive: true })
  const clips: string[] = []
  try {
    const speaker = SPEECH === 'kokoro' ? kokoro(videoDir) : null
    for (const [i, text] of PHRASES.entries()) {
      const wav = join(dir, `${SPEECH}-${i}.wav`)
      if (!existsSync(wav)) {
        if (speaker) {
          const pcm = toPcm(await speaker.synthesize(text, { voice: 'af_heart', speed: 1 }))
          writeWav(wav, { rate: 24_000, samples: new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2) })
        } else {
          const aiff = join(dir, `say-${i}.aiff`)
          tool('say', ['-o', aiff, text])
          ffmpeg(['-loglevel', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '24000', wav])
        }
      }
      clips.push(wav)
    }
  } catch (e) {
    return { engine: SPEECH, ms: Date.now() - t, error: e instanceof Error ? e.message.slice(0, 800) : String(e) }
  }
  // Phrases with 2.5 s gaps, looped to the length (speech about half the time, like a narrated take).
  const list = join(dir, 'list.txt')
  const gap = join(dir, 'gap.wav')
  ffmpeg(['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '2.5', gap])
  const lines: string[] = []
  for (let k = 0; k < 200; k++) lines.push(`file '${clips[k % clips.length]}'`, `file '${gap}'`)
  writeFileSync(list, lines.join('\n'))
  ffmpeg(['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-t', String(SECONDS), '-ar', '48000', file])
  return { engine: SPEECH, ms: Date.now() - t }
}

/** One 50 s page: a background, a sidebar, a header and cards in a per-page layout; a cursor that moves 7 s, rests 5 s. */
function pageFilter(p: number): string {
  const bg = ['0xf4f5f7', '0x0b0d10', '0xeef2ff', '0x111827', '0xfff7ed', '0x1e1b4b'][p % 6]!
  const panel = p % 2 ? '0x374151' : '0xd1d5db'
  const accent = ['0x14b8a6', '0x6366f1', '0xf43f5e', '0x22c55e', '0xf59e0b', '0x38bdf8'][p % 6]!
  const dx = [0, 220, 80, 300, 140, 0][p % 6]!
  const dy = [0, 120, 260, 40, 200, 100][p % 6]!
  const cards = Array.from({ length: 6 }, (_, i) => {
    const x = 420 + (i % 3) * 700 + dx - (i % 3 === 2 ? dx : 0)
    const y = 260 + Math.floor(i / 3) * 520 + dy / 2
    return `drawbox=x=${x}:y=${y}:w=640:h=460:color=${panel}:t=fill`
  })
  // A "click" flashes card (k mod 6) for 0.3 s at the end of each 12 s move cycle.
  const flashes = Array.from({ length: 6 }, (_, i) => {
    const x = 420 + (i % 3) * 700 + dx - (i % 3 === 2 ? dx : 0)
    const y = 260 + Math.floor(i / 3) * 520 + dy / 2
    return `drawbox=x=${x}:y=${y}:w=640:h=460:color=${accent}:t=fill:enable='between(mod(t,12),6.8,7.1)*eq(mod(floor(t/12)+${p},6),${i})'`
  })
  return [
    `color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${PAGE_S}`,
    `drawbox=x=0:y=0:w=360:h=${H}:color=${panel}:t=fill`,
    `drawbox=x=360:y=0:w=${W - 360}:h=140:color=${accent}:t=fill`,
    ...cards,
    ...flashes,
  ].join(',')
}

async function makeFixture(file: string) {
  if (existsSync(file)) return { cached: true }
  const audio = join(outDir, 'speech.wav')
  const speech = await speechTrack(audio)
  log('speech', speech)
  const pages = Math.ceil(SECONDS / PAGE_S)
  const inputs: string[] = []
  const graph: string[] = []
  for (let p = 0; p < pages; p++) {
    inputs.push('-f', 'lavfi', '-i', pageFilter(p))
    graph.push(`[${p}:v]`)
  }
  // The cursor: moves along a Lissajous path for 7 s of every 12, rests for 5 s (freezedetect sees idle).
  const cur = pages
  inputs.push('-f', 'lavfi', '-i', `color=c=white:s=24x24:r=${FPS}:d=${SECONDS},drawbox=x=0:y=0:w=24:h=24:color=black:t=3`)
  // A static high-detail texture (like text) so the encoder spends realistic bits, mostly on the 1 s keyframes.
  const tex = pages + 1
  inputs.push('-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=${FPS}:d=${SECONDS},geq=lum='128+60*sin(X*1.7)*cos(Y*2.3)+40*(random(1)-0.5)':cb=128:cr=128`)
  const tm = `(floor(t/12)*7+min(mod(t,12),7))`
  const filter = `[${tex}:v]trim=end_frame=1,loop=loop=-1:size=1,setpts=N/${FPS}/TB[tx];${graph.join('')}concat=n=${pages}:v=1:a=0[pg];[pg][tx]blend=all_mode=overlay:all_opacity=0.35:shortest=1[bg];[bg][${cur}:v]overlay=x='1200+900*sin(${tm}*0.6)':y='700+450*sin(${tm}*0.43)':shortest=1[v]`
  const audioIn = existsSync(audio) && !speech.error ? ['-i', audio] : []
  const t = Date.now()
  const r = await runGroup('fixture', 'ffmpeg', [
    ...['-loglevel', 'error', '-y', ...inputs, ...audioIn, '-filter_complex', filter, '-map', '[v]'],
    ...(audioIn.length ? ['-map', `${pages + 2}:a`, '-c:a', 'aac', '-b:a', '96k'] : []),
    ...['-c:v', 'libx264', '-preset', 'superfast', '-b:v', '3500k', '-maxrate', '4500k', '-bufsize', '7000k'],
    ...['-g', `${FPS}`, '-keyint_min', `${FPS}`, '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-t', String(SECONDS), '-movflags', '+faststart', file],
  ], { deadlineMs: 30 * 60_000 })
  if (!r.ok) throw new Error(`fixture: ${r.stderrTail.slice(-1500)}`)
  return { cached: false, ms: Date.now() - t, speech }
}

// ---------- 2. Analysis stages ----------

const parseFreeze = (text: string) => {
  const out: { start: number; end: number }[] = []
  let s: number | null = null
  for (const line of text.split('\n')) {
    const a = /freeze_start[:=] ?([\d.]+)/.exec(line)
    const b = /freeze_end[:=] ?([\d.]+)/.exec(line)
    if (a) s = Number(a[1])
    if (b && s !== null) {
      out.push({ start: s, end: Number(b[1]) })
      s = null
    }
  }
  if (s !== null) out.push({ start: s, end: SECONDS })
  return out
}
const parseScdet = (text: string) =>
  [...text.matchAll(/lavfi\.scd\.time[:=] ?([\d.]+)/g)].map((m) => Number(m[1]))

async function ffText(label: string, args: string[]) {
  const r = await runGroup(label, 'ffmpeg', ['-hide_banner', '-nostats', ...args], { deadlineMs: 15 * 60_000 })
  if (!r.ok) throw new Error(`${label}: ${r.stderrTail.slice(-800)}`)
  return { text: `${r.stdout}\n${r.stderrTail}`, cpuS: round((r.cpuUserS ?? 0) + (r.cpuSysS ?? 0), 1), peakMb: r.peakTreeRssMb }
}

/** stderrTail is only 8 KB, so freeze/scdet events go through metadata=print to a file instead. */
async function filterEvents(label: string, file: string, vf: string) {
  const meta = join(outDir, `${label}.meta.txt`)
  rmSync(meta, { force: true })
  const r = await ffText(label, ['-i', file, '-map', '0:v', '-vf', `${vf},metadata=mode=print:file=${meta.replace(/:/g, '\\:')}`, '-f', 'null', '-'])
  return { ...r, meta: existsSync(meta) ? readFileSync(meta, 'utf8') : '' }
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
  n: number
}

/** Grey 320-wide frames at DIFF_FPS streamed through Node: per frame, changed regions and a small-blob cursor guess. */
async function diffPass(file: string, metaFile?: string) {
  const w = 320
  const h = Math.round((w * H) / W)
  const size = w * h
  const scale = W / w
  const grey = `fps=${DIFF_FPS},scale=${w}:${h}:flags=area,format=gray`
  // With metaFile: one decode feeds both freezedetect+scdet (640 wide, events to metaFile) and the grey frames.
  const graph = metaFile
    ? ['-filter_complex', `[0:v]split=2[a][b];[a]scale=640:-2,freezedetect=n=-70dB:d=1.2,scdet=threshold=${SCDET},metadata=mode=print:file=${metaFile.replace(/:/g, '\\:')},nullsink;[b]${grey}[g]`, '-map', '[g]']
    : ['-map', '0:v', '-vf', grey]
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', file, ...graph, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] })
  let prev: Buffer | null = null
  let pending: Buffer = Buffer.alloc(0)
  let frames = 0
  let active = 0
  // Idle from the diff pass: runs of frames with no changed pixels, longer than 1.2 s (compare freezedetect).
  const idle: { start: number; end: number }[] = []
  let quietSince: number | null = 0
  const cursor: [number, number, number][] = []
  const boxes: { t: number; box: Box }[] = []
  const labels = new Int32Array(size)
  const parent: number[] = []
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!
    return a
  }
  const handle = (cur: Buffer) => {
    const t = frames / DIFF_FPS
    frames++
    if (prev) {
      // Threshold the neighbour difference, then two-pass connected components (4-neighbour, union-find).
      labels.fill(0)
      parent.length = 1
      parent[0] = 0
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x
          if (Math.abs(cur[i]! - prev[i]!) < 18) continue
          const up = y ? labels[i - w]! : 0
          const left = x ? labels[i - 1]! : 0
          if (!up && !left) {
            parent.push(parent.length)
            labels[i] = parent.length - 1
          } else if (up && left) {
            const a = find(up)
            const b = find(left)
            labels[i] = Math.min(a, b)
            parent[Math.max(a, b)] = Math.min(a, b)
          } else labels[i] = up || left
        }
      const comps = new Map<number, Box>()
      for (let i = 0; i < size; i++) {
        if (!labels[i]) continue
        const r = find(labels[i]!)
        const x = i % w
        const y = (i / w) | 0
        const b = comps.get(r)
        if (!b) comps.set(r, { x0: x, y0: y, x1: x, y1: y, n: 1 })
        else {
          b.x0 = Math.min(b.x0, x)
          b.y0 = Math.min(b.y0, y)
          b.x1 = Math.max(b.x1, x)
          b.y1 = Math.max(b.y1, y)
          b.n++
        }
      }
      if (!comps.size) quietSince ??= t
      else {
        if (quietSince !== null && t - quietSince > 1.2) idle.push({ start: round(quietSince, 2), end: round(t, 2) })
        quietSince = null
      }
      if (comps.size) {
        active++
        const sorted = [...comps.values()].sort((a, b) => b.n - a.n)
        boxes.push({ t: round(t, 2), box: sorted[0]! })
        // Cursor guess: a component 8-48 source px across (1-6 px here).
        const blob = sorted.find((b) => {
          const bw = (b.x1 - b.x0 + 1) * scale
          const bh = (b.y1 - b.y0 + 1) * scale
          return bw >= 8 && bw <= 64 && bh >= 8 && bh <= 64
        })
        if (blob) cursor.push([round(t, 2), Math.round(((blob.x0 + blob.x1 + 1) / 2) * scale), Math.round(((blob.y0 + blob.y1 + 1) / 2) * scale)])
      }
    }
    prev = Buffer.from(cur)
  }
  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= size) {
      handle(pending.subarray(0, size))
      pending = pending.subarray(size)
    }
  }
  await new Promise((r) => ff.on('close', r))
  const end = frames / DIFF_FPS
  if (quietSince !== null && end - quietSince > 1.2) idle.push({ start: round(quietSince, 2), end: round(end, 2) })
  return { frames, activeFrames: active, idle: idle.length, idleS: round(idle.reduce((a, f) => a + f.end - f.start, 0), 1), cursorPoints: cursor.length, largestBoxes: boxes.length, sample: { cursor: cursor.slice(0, 5), box: boxes[0] ?? null } }
}

/** Runs fns with at most JOBS at once. */
async function pool<T>(fns: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(fns.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(JOBS, fns.length) }, async () => {
      while (next < fns.length) {
        const i = next++
        out[i] = await fns[i]!()
      }
    }),
  )
  return out
}

const frameAt = (file: string, t: number, out: string, vf: string) =>
  runGroup('frame', 'ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '4', out], { deadlineMs: 60_000 })

/** One sheet per scene (at most 24): 12 frames evenly spaced, 320 px each, tiled 4x3 into a 1280-wide JPEG. */
async function contactSheets(file: string, scenes: number[], dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const bounds = [0, ...scenes, SECONDS]
  const spans = bounds.slice(1).map((e, i) => [bounds[i]!, e] as const).filter(([a, b]) => b - a > 0.5).slice(0, 24)
  const jobs: (() => Promise<unknown>)[] = []
  spans.forEach(([a, b], s) => {
    for (let k = 0; k < 12; k++) {
      const t = round(a + ((b - a) * (k + 0.5)) / 12, 3)
      jobs.push(() => frameAt(file, t, join(dir, `s${s}-${String(k).padStart(2, '0')}.jpg`), 'scale=320:-2'))
    }
  })
  await pool(jobs)
  await pool(spans.map((_, s) => () => runGroup('tile', 'ffmpeg', ['-loglevel', 'error', '-y', '-framerate', '1', '-i', join(dir, `s${s}-%02d.jpg`), '-vf', 'tile=4x3', '-frames:v', '1', '-q:v', '4', join(dir, `sheet-${s}.jpg`)], { deadlineMs: 60_000 })))
  return { sheets: spans.length, frames: jobs.length }
}

/** 12 focus crops: full-resolution frame at the step's moment, cropped to a zoom-2 box, 1280 wide. */
async function focusCrops(file: string, dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const jobs = Array.from({ length: 12 }, (_, k) => () => {
    const t = round(6.9 + k * 24, 2)
    const x = 420 + (k % 3) * 700
    return frameAt(file, Math.min(t, SECONDS - 1), join(dir, `step${k}.jpg`), `crop=${W / 2}:${H / 2}:${Math.min(x, W / 2)}:${H / 4},scale=1280:-2`)
  })
  await pool(jobs)
  return { crops: jobs.length }
}

async function transcribe(file: string) {
  const dir = join(outDir, 'transcribe')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const wav = join(dir, 'audio.wav')
  const extract = await timed('transcribe.extract', () => ffmpeg(['-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav]))
  const install = await runGroup('parakeet.install', 'npx', ['hyperframes', 'models', 'install', 'parakeet'], { cwd: videoDir, deadlineMs: 15 * 60_000 })
  log('stage', { stage: 'transcribe.install', ms: install.wallMs, ok: install.ok })
  const r = await runGroup('parakeet', 'npx', ['hyperframes', 'transcribe', wav, '--engine', 'parakeet', '--language', 'en', '--dir', dir, '--json'], { cwd: videoDir, deadlineMs: 15 * 60_000 })
  log('stage', { stage: 'transcribe.run', ms: r.wallMs, ok: r.ok })
  const words = (() => {
    try {
      const line = r.stdout.trim().split('\n').reverse().find((l) => l.startsWith('{')) ?? '{}'
      return (JSON.parse(line) as { wordCount?: number }).wordCount ?? null
    } catch {
      return null
    }
  })()
  return { extractMs: extract.ms, install: metrics(install), run: { ...metrics(r), realTimeFactor: round(r.wallMs / 1000 / SECONDS, 3) }, words }
}

// ---------- Main ----------

const fixture = join(outDir, 'recording.mp4')
const made = await makeFixture(fixture)
const fp = probe(fixture)
const fv = fp.streams?.find((s) => s.codec_type === 'video')
const fa = fp.streams?.find((s) => s.codec_type === 'audio')
log('fixture', { ...made, bytes: Number(fp.format?.size), durationS: Number(fp.format?.duration), video: `${fv?.width}x${fv?.height}`, audio: fa?.codec_name ?? null })

const stages: Record<string, unknown> = {}
const full = await timed('full', async () => {
  const p = await timed('probe', () => tool('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', fixture]))
  stages.probe = { ms: p.ms }
  const sha = await timed('sha256', () => sha256File(fixture))
  stages.sha256 = { ms: sha.ms }
  const fz = await timed('freezedetect', () => filterEvents('freeze', fixture, 'scale=640:-2,freezedetect=n=-70dB:d=1.2'))
  const freezes = parseFreeze(fz.value.meta)
  stages.freezedetect = { ms: fz.ms, cpuS: fz.value.cpuS, idle: freezes.length, idleS: round(freezes.reduce((a, f) => a + f.end - f.start, 0), 1) }
  const sc = await timed('scdet', () => filterEvents('scdet', fixture, `scale=640:-2,scdet=threshold=${SCDET}`))
  const scenes = parseScdet(sc.value.meta)
  stages.scdet = { ms: sc.ms, cpuS: sc.value.cpuS, threshold: SCDET, scenes: scenes.length, times: scenes.slice(0, 12).map((t) => round(t, 2)) }
  const both = await timed('freeze+scdet', () => filterEvents('both', fixture, `scale=640:-2,freezedetect=n=-70dB:d=1.2,scdet=threshold=${SCDET}`))
  stages.freezeAndScdetOnePass = { ms: both.ms, cpuS: both.value.cpuS }
  const diff = await timed('diff', () => diffPass(fixture))
  stages.diff = { ms: diff.ms, fps: DIFF_FPS, ...diff.value }
  // The pipeline the plan should use: a single decode for freezedetect, scdet and the diff frames.
  const meta = join(outDir, 'onedecode.meta.txt')
  rmSync(meta, { force: true })
  const one = await timed('onedecode', () => diffPass(fixture, meta))
  const oneText = existsSync(meta) ? readFileSync(meta, 'utf8') : ''
  stages.oneDecode = { ms: one.ms, idle: parseFreeze(oneText).length, scenes: parseScdet(oneText).length, activeFrames: one.value.activeFrames }
  const sheets = await timed('sheets', () => contactSheets(fixture, scenes, join(outDir, 'sheets')))
  stages.sheets = { ms: sheets.ms, ...sheets.value }
  const crops = await timed('crops', () => focusCrops(fixture, join(outDir, 'focus')))
  stages.crops = { ms: crops.ms, ...crops.value }
  const tr = fa ? await timed('transcribe', () => transcribe(fixture)) : null
  stages.transcribe = tr ? { ms: tr.ms, ...tr.value } : { skipped: 'no audio track' }
  writeFileSync(join(outDir, 'analysis.json'), JSON.stringify({ sha256: sha.value, analyzer: ANALYZER_VERSION, freezes, scenes }))
  return { scenes }
})

// Cache hit: hash, match, reuse; only the sheets and crops are made again.
const cached = await timed('cached', async () => {
  const sha = sha256File(fixture)
  const a = JSON.parse(readFileSync(join(outDir, 'analysis.json'), 'utf8')) as { sha256: string; analyzer: string; scenes: number[] }
  if (a.sha256 !== sha || a.analyzer !== ANALYZER_VERSION) throw new Error('cache miss')
  await contactSheets(fixture, a.scenes, join(outDir, 'sheets'))
  await focusCrops(fixture, join(outDir, 'focus'))
  return true
})

function pipelineMs() {
  const ms = (k: string) => (stages[k] as { ms?: number } | undefined)?.ms ?? 0
  return ['probe', 'sha256', 'oneDecode', 'sheets', 'crops', 'transcribe'].reduce((a, k) => a + ms(k), 0)
}

const summary = {
  env: { platform: platform(), arch: arch(), cpus: availableParallelism(), jobs: JOBS, memGb: round(totalmem() / 2 ** 30, 1), ffmpeg: tool('ffmpeg', ['-version']).split('\n')[0], python3: which('python3') !== null },
  fixture: { ...made, bytes: Number(fp.format?.size), durationS: Number(fp.format?.duration), video: `${fv?.width}x${fv?.height}`, audio: fa?.codec_name ?? null },
  stages,
  // Every stage above runs for the measurement; the pipeline is probe + sha256 + one decode + sheets + crops + transcribe.
  pipelineMs: pipelineMs(),
  measuredMs: full.ms,
  cachedMs: cached.ms,
  pass: { pipelineUnder3Min: pipelineMs() < 180_000, cachedUnder20s: cached.ms < 20_000 },
  wallMs: Date.now() - started,
}
printSummary('D3-JSON', join(outDir, 'summary.json'), summary)
