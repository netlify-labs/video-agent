// Spike D1 (plan 2026-11-04-screen-recording-demo §10 Phase 0): does HyperFrames render a recording clip with
// data-media-start + data-playback-rate frame-accurately inside a later, zoomed scene, and can a clip hold a frame?
//   npx tsx spikes/d1/render.ts [--out /tmp/va-d1] [--variant local,global] [--quality standard] [--seconds 30]
// The fixture is a 2560x1440 30 fps H.264 file (1 s GOPs) whose every frame carries its own number as a 4x4 grid of
// 160 px black/white blocks centred in the frame (11 bits of frame number + 5 check bits), so output frames are read
// back by sampling block centres, with no OCR. The composition (1920x1080):
//   intro  0-4 s      a title card
//   rec    4-11.5 s   <video> in a .va-stage that GSAP scales 1 -> 1.4 around the grid centre; media 12.4 -> 21.8
//                     (rate 1.25333)
//   slow   11.5-17.5  media 22.0 -> 24.0 at rate 0.5 (data-duration 4 inside a 6 s beat: what shows for the last 2 s?)
//   eof    17.5-19.5  data-media-start past the end of the file (the linter's "final-frame hold")
//   base   19.5-21.5  media 3.0 at rate 1, no transform (baseline)
// Variants: local (video data-start=0 inside its beat, default basis) and global (data-start = absolute time,
// data-hf-media-start-basis="global"). Per output frame: expected source frame (floor and round of the source time) vs
// decoded; JSON lines on stderr, a summary between ===D1-JSON=== lines and in <out>/summary.json.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, arch, platform, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { log, metrics, parseFlags, printSummary, probe, repoRoot, round, runGroup, tool } from '../lib/proc.js'

const flags = parseFlags(process.argv.slice(2))
const outDir = flags.out ?? join(tmpdir(), 'va-d1')
const quality = flags.quality ?? 'standard'
const variants = (flags.variant ?? 'local,global').split(',')
const SRC_W = 2560
const SRC_H = 1440
const SRC_SECONDS = Number(flags.seconds ?? 30)
const FPS = 30
const W = 1920
const H = 1080
const BLOCK = 160
const GRID = 4
const hfBin = join(repoRoot, 'node_modules', '.bin', 'hyperframes')
const hf = existsSync(hfBin) ? { cmd: hfBin, pre: [] as string[] } : { cmd: 'npx', pre: ['-y', 'hyperframes'] }
mkdirSync(outDir, { recursive: true })

// ---------- Fixture ----------

/** 16 bits: frame number in bits 0-10, bits 11-15 = complement of bits 0-4 (so a blank or torn frame fails the check). */
const encode = (n: number) => (n & 0x7ff) | ((~n & 0x1f) << 11)
const decodeBits = (bits: number) => {
  const n = bits & 0x7ff
  return ((~n & 0x1f) << 11) === (bits & 0xf800) ? n : null
}

/** Writes raw yuv420p frames to ffmpeg's stdin: grid in the middle, a moving square, mid-grey background. */
async function makeFixture(file: string) {
  if (existsSync(file)) return
  const frames = SRC_SECONDS * FPS
  const ySize = SRC_W * SRC_H
  const frame = Buffer.alloc(ySize * 1.5)
  const ff = spawn(
    'ffmpeg',
    [
      ...['-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${SRC_W}x${SRC_H}`, '-r', `${FPS}`],
      ...['-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', `${FPS}`, '-keyint_min', `${FPS}`],
      ...['-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file],
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  const gx = SRC_W / 2 - (GRID * BLOCK) / 2
  const gy = SRC_H / 2 - (GRID * BLOCK) / 2
  for (let n = 0; n < frames; n++) {
    frame.fill(128)
    const bits = encode(n)
    for (let b = 0; b < 16; b++) {
      const v = (bits >> b) & 1 ? 235 : 16
      const x0 = gx + (b % GRID) * BLOCK
      const y0 = gy + Math.floor(b / GRID) * BLOCK
      for (let y = y0; y < y0 + BLOCK; y++) frame.fill(v, y * SRC_W + x0, y * SRC_W + x0 + BLOCK)
    }
    const sx = Math.round(((n * 17) % (SRC_W - 200)) + 50)
    for (let y = 100; y < 260; y++) frame.fill(235, y * SRC_W + sx, y * SRC_W + sx + 160)
    if (!ff.stdin.write(frame)) await new Promise((r) => ff.stdin.once('drain', r))
  }
  ff.stdin.end()
  const code = await new Promise<number | null>((r) => ff.on('close', r))
  if (code !== 0) throw new Error(`ffmpeg fixture exited ${code}`)
}

// ---------- Composition ----------

interface Scene {
  id: string
  start: number
  duration: number
  /** Media clip in the scene; omitted for the intro. */
  media?: { in: number; rate: number; clipDuration: number }
  zoom?: { from: number; to: number }
}
const SCENES: Scene[] = [
  { id: 'intro', start: 0, duration: 4 },
  { id: 'rec', start: 4, duration: 7.5, media: { in: 12.4, rate: round((21.8 - 12.4) / 7.5, 5), clipDuration: 7.5 }, zoom: { from: 1, to: 1.4 } },
  { id: 'slow', start: 11.5, duration: 6, media: { in: 22.0, rate: 0.5, clipDuration: 4 } },
  { id: 'eof', start: 17.5, duration: 2, media: { in: SRC_SECONDS + 1, rate: 1, clipDuration: 2 } },
  { id: 'base', start: 19.5, duration: 2, media: { in: 3.0, rate: 1, clipDuration: 2 } },
]
const TOTAL = 21.5

function writeComp(dir: string, variant: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'vendor'), { recursive: true })
  mkdirSync(join(dir, 'assets', 'media'), { recursive: true })
  for (const f of ['gsap.min.js', 'va-contract.js']) copyFileSync(join(repoRoot, 'video', 'vendor', f), join(dir, 'vendor', f))
  for (const f of ['hyperframes.json', 'meta.json']) copyFileSync(join(repoRoot, 'video', f), join(dir, f))
  copyFileSync(join(outDir, 'fixture.mp4'), join(dir, 'assets', 'media', 'fixture.mp4'))
  const global = variant === 'global'
  const beats = SCENES.map((s) => {
    const body = s.media
      ? `<div class="va-stage" data-va-stage="${s.id}">
          <video id="v-${s.id}" data-va-media="${s.id}-clip" data-va-kind="video" src="assets/media/fixture.mp4" muted
            data-start="${global ? s.start : 0}" data-duration="${s.media.clipDuration}" data-media-start="${s.media.in}"
            data-playback-rate="${s.media.rate}"${global ? ' data-hf-media-start-basis="global"' : ''}></video>
        </div>`
      : `<div class="card"><h1 class="title" data-va-text="${s.id}-title" data-va-label="Headline">Intro</h1></div>`
    const tween = s.zoom
      ? `tl.fromTo(el.querySelector('.va-stage'), { scale: ${s.zoom.from} }, { scale: ${s.zoom.to}, duration: ${s.duration}, ease: 'none' }, 0)`
      : s.media
        ? ''
        : `tl.fromTo(el.querySelector('.title'), { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0)`
    return `<section id="b-${s.id}" class="clip beat" data-va-beat="${s.id}" data-composition-id="${s.id}" data-va-label="${s.id}" data-start="${s.start}" data-duration="${s.duration}" data-va-authored-duration="${s.duration}" data-track-index="0">
        ${body}
        <script>vaBeat('${s.id}', (tl, el) => { ${tween} })</script>
      </section>`
  }).join('\n      ')
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="vendor/gsap.min.js"></script>
    <script src="vendor/va-contract.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #root { width: 100%; height: 100%; position: relative; background: #000; font-family: system-ui, sans-serif; }
      .beat { position: absolute; inset: 0; overflow: hidden; }
      .va-stage { position: absolute; inset: 0; transform-origin: 50% 50%; }
      .va-stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .card { position: absolute; inset: 0; display: grid; place-items: center; }
      .title { color: #fff; font-size: 96px; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-va-contract="1" data-start="0" data-duration="${TOTAL}" data-width="${W}" data-height="${H}" data-fps="${FPS}">
      ${beats}
    </div>
    <script>
      window.__timelines['main'] = gsap.timeline({ paused: true })
    </script>
  </body>
</html>
`,
  )
}

// ---------- Read back ----------

/** Decodes every output frame's grid (luma at block centres under the scene's zoom). Null when the check bits fail. */
function readFrames(file: string): (number | null)[] {
  // Quarter size keeps the pipe small (blocks are still 30 px at zoom 1).
  const q = 4
  const w = W / q
  const h = H / q
  const raw = spawnSyncBuffer('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  const size = w * h
  const out: (number | null)[] = []
  const k = W / SRC_W
  for (let f = 0; f * size < raw.length; f++) {
    const t = f / FPS
    const scene = SCENES.find((s) => t >= s.start - 1e-9 && t < s.start + s.duration - 1e-9)
    const z = scene?.zoom ? scene.zoom.from + ((scene.zoom.to - scene.zoom.from) * (t - scene.start)) / scene.duration : 1
    let bits = 0
    let contrast = 0
    for (let b = 0; b < 16; b++) {
      const sx = SRC_W / 2 + ((b % GRID) - GRID / 2 + 0.5) * BLOCK
      const sy = SRC_H / 2 + (Math.floor(b / GRID) - GRID / 2 + 0.5) * BLOCK
      const x = Math.round((W / 2 + (sx * k - W / 2) * z) / q)
      const y = Math.round((H / 2 + (sy * k - H / 2) * z) / q)
      const v = raw[f * size + y * w + x]!
      contrast = Math.max(contrast, Math.abs(v - 128))
      if (v > 128) bits |= 1 << b
    }
    out.push(contrast < 40 ? null : decodeBits(bits))
  }
  return out
}

function spawnSyncBuffer(cmd: string, args: string[]): Buffer {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}: ${r.stderr?.toString().slice(0, 500)}`)
  return r.stdout
}

function analyse(decoded: (number | null)[]) {
  const perScene: Record<string, unknown> = {}
  for (const s of SCENES) {
    if (!s.media) continue
    const rows: { f: number; t: number; got: number | null; floor: number; round: number; boundary: boolean; ok: boolean }[] = []
    for (let f = Math.round(s.start * FPS); f < Math.round((s.start + s.duration) * FPS); f++) {
      const local = f / FPS - s.start
      const inClip = local < s.media.clipDuration - 1e-9
      const srcT = Math.min(s.media.in + Math.min(local, s.media.clipDuration) * s.media.rate, SRC_SECONDS - 1 / FPS)
      const exact = srcT * FPS
      const floor = Math.floor(exact + 1e-6)
      // Within 1e-3 of a frame boundary float rounding goes either way (465.99975 -> 466 but 559.9995 -> 559).
      const off = Math.abs(exact - Math.round(exact))
      const boundary = off < 1e-3 && off > 1e-6
      const got = decoded[f] ?? null
      const ok = got === floor || (boundary && (got === Math.round(exact) || got === Math.round(exact) - 1))
      rows.push({ f, t: round(local, 4), got, floor, round: Math.round(exact), boundary, ok })
      log('frame', { scene: s.id, f, local: round(local, 4), inClip, got, floor, round: Math.round(exact), boundary, ok })
    }
    const inClip = rows.filter((r) => r.t < s.media!.clipDuration - 1e-9)
    const after = rows.filter((r) => r.t >= s.media!.clipDuration - 1e-9)
    const diff = (key: 'floor' | 'round') => {
      const hist: Record<string, number> = {}
      for (const r of inClip) {
        const d = r.got === null ? 'none' : String(r.got - r[key])
        hist[d] = (hist[d] ?? 0) + 1
      }
      return hist
    }
    perScene[s.id] = {
      frames: rows.length,
      clipFrames: inClip.length,
      exact: inClip.filter((r) => r.ok).length,
      boundaryFrames: inClip.filter((r) => r.boundary).length,
      wrong: inClip.filter((r) => !r.ok).map((r) => ({ f: r.f, got: r.got, expected: r.floor })).slice(0, 10),
      vsFloor: diff('floor'),
      vsRound: diff('round'),
      firstGot: inClip[0]?.got ?? null,
      lastGot: inClip.at(-1)?.got ?? null,
      expectedFirstFloor: inClip[0]?.floor,
      expectedLastFloor: inClip.at(-1)?.floor,
      afterClip: after.length ? { frames: after.length, values: [...new Set(after.map((r) => r.got))].slice(0, 8) } : null,
    }
  }
  return perScene
}

// ---------- Main ----------

const started = Date.now()
const fixture = join(outDir, 'fixture.mp4')
await makeFixture(fixture)
const fp = probe(fixture)
const fv = fp.streams?.find((s) => s.codec_type === 'video')
log('fixture', { file: fixture, width: fv?.width, height: fv?.height, frames: Number(fv?.nb_frames), bytes: Number(fp.format?.size) })

const summary: Record<string, unknown> = {
  env: { platform: platform(), arch: arch(), cpus: availableParallelism(), memGb: round(totalmem() / 2 ** 30, 1), hyperframes: tool(hf.cmd, [...hf.pre, '--version']).trim(), quality },
  fixture: { width: fv?.width, height: fv?.height, frames: Number(fv?.nb_frames), gop: FPS },
}
for (const variant of variants) {
  const dir = join(outDir, variant)
  writeComp(dir, variant)
  const check = await runGroup('check', hf.cmd, [...hf.pre, 'check'], { cwd: dir, deadlineMs: 10 * 60_000 })
  const checkText = `${check.stdout}\n${check.stderrTail}`
  const findings = [...new Set(checkText.split('\n').filter((l) => /[✗⚠]|error|warning/i.test(l)).map((l) => l.trim()).filter(Boolean))].slice(0, 20)
  log('check', { variant, ok: check.ok, findings })
  const output = join(outDir, `${variant}.mp4`)
  const r = await runGroup('render', hf.cmd, [...hf.pre, 'render', '--quality', quality, '--output', output], { cwd: dir, deadlineMs: 20 * 60_000 })
  const text = `${r.stdout}\n${r.stderrTail}`
  log('render', { variant, ok: r.ok, wallMs: r.wallMs })
  if (!r.ok) {
    summary[variant] = { check: findings, render: { ok: false, tail: r.stderrTail.slice(-2000) } }
    continue
  }
  const decoded = readFrames(output)
  summary[variant] = {
    check: findings,
    render: { ...metrics(r), secondsPerOutputSecond: round(r.wallMs / 1000 / TOTAL, 2), renderedInS: Number(/rendered in ([\d.]+)s/.exec(text)?.[1] ?? 'NaN') },
    outputFrames: decoded.length,
    scenes: analyse(decoded),
  }
}
summary.wallMs = Date.now() - started
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
printSummary('D1', join(outDir, 'summary.json'), summary)
