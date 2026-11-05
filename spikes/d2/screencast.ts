// Spike D2 (plan 2026-11-04-screen-recording-demo §4.6, §10 Phase 0): CDP Page.startScreencast frame rate at
// 1280x800 @2x while a busy page scrolls, and the clock offset between page pointer events
// (performance.timeOrigin + performance.now()) and screencast frame timestamps (metadata.timestamp, epoch seconds).
//   npx tsx spikes/d2/screencast.ts [--out /tmp/va-d2] [--mode headed,headless,headed-flag,headless-flag] [--seconds 20]
//        [--flashes 24]
// Modes: headed/headless emulate dpr 2 with Playwright's deviceScaleFactor; *-flag launch with
// --force-device-scale-factor=2, viewport null and a CDP metrics override instead, to see which gives 2x pixels.
// Headed Chromium is placed off-screen so the prototype doesn't cover the desktop. The page (a long, animated list)
// scrolls under page.mouse.wheel while the mouse moves along a known path; every click paints a corner box in the next
// colour of a cycle, so the first frame showing that colour dates the click on the frame clock. Every frame is saved as
// JPEG and the box colour read back with ffmpeg. JSON lines on stderr, a summary between ===D2-JSON=== lines.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { arch, availableParallelism, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { log, parseFlags, printSummary, quantile, round } from '../lib/proc.js'

const flags = parseFlags(process.argv.slice(2))
const outDir = flags.out ?? join(tmpdir(), 'va-d2')
const modes = (flags.mode ?? 'headed,headless,headed-flag,headless-flag').split(',')
const SECONDS = Number(flags.seconds ?? 20)
const FLASHES = Number(flags.flashes ?? 24)
const VIEW = { width: 1280, height: 800 }
const DPR = 2
const BOX = 120
/** Distinct, JPEG-robust colours; a click sets the next one. Index 0 is the resting colour. */
const COLOURS: [number, number, number][] = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [0, 255, 255],
  [255, 0, 255],
  [255, 255, 255],
]
mkdirSync(outDir, { recursive: true })

const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px system-ui; background: #f4f5f7; }
  .row { height: 64px; margin: 8px 24px; border-radius: 12px; display: flex; align-items: center; padding: 0 16px;
         background: linear-gradient(90deg, #14b8a6, #6366f1, #f43f5e); background-size: 300% 100%;
         animation: slide 2s linear infinite; color: #fff; }
  .row:nth-child(3n) { animation-duration: 1.3s; }
  .spin { width: 32px; height: 32px; border: 4px solid #fff; border-top-color: transparent; border-radius: 50%;
          animation: spin .8s linear infinite; margin-right: 16px; }
  @keyframes slide { to { background-position: 300% 0; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  #box { position: fixed; left: 0; top: 0; width: ${BOX}px; height: ${BOX}px; background: rgb(0,0,0); z-index: 9; }
</style></head><body><div id="box"></div>
${Array.from({ length: 400 }, (_, i) => `<div class="row"><div class="spin"></div>Row ${i + 1}</div>`).join('')}
</body></html>`

/** Logged in the page: pointer events stamped like the recorder's trace (epoch ms), and the flash colour index. */
const INIT = `(() => {
  const now = () => performance.timeOrigin + performance.now()
  window.__trace = []
  let k = 0
  addEventListener('pointermove', (e) => window.__trace.push({ t: now(), type: 'move', x: e.clientX, y: e.clientY }), { capture: true, passive: true })
  addEventListener('pointerdown', (e) => {
    const t = now()
    k = (k % ${COLOURS.length - 1}) + 1
    document.getElementById('box').style.background = ${JSON.stringify(COLOURS.map(([r, g, b]) => `rgb(${r},${g},${b})`))}[k]
    window.__trace.push({ t, type: 'down', x: e.clientX, y: e.clientY, k })
  }, { capture: true })
})()`

interface Frame {
  i: number
  ts: number
  recvMs: number
  file: string
}

async function run(mode: string) {
  const dir = join(outDir, mode)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const headed = mode.startsWith('headed')
  const flag = mode.endsWith('-flag')
  const browser = await chromium.launch({
    headless: !headed,
    args: [
      ...(headed ? ['--window-position=-3000,0', `--window-size=${VIEW.width},${VIEW.height + 120}`] : []),
      ...(flag ? [`--force-device-scale-factor=${DPR}`] : []),
    ],
  })
  // The flag modes are the recorder's recipe: no Playwright viewport emulation (it would reset dpr to 1), then a CDP
  // metrics override for an exact 1280x800 that keeps the flag's scale (deviceScaleFactor 0 = don't override).
  const context = await browser.newContext(flag ? { viewport: null } : { viewport: VIEW, deviceScaleFactor: DPR })
  await context.addInitScript(INIT)
  const page = await context.newPage()
  if (flag)
    await (await context.newCDPSession(page)).send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 0, mobile: false })
  // A real navigation (not setContent) so the init script runs, as it would on the recorder's target site.
  await page.route('http://d2.test/', (r) => r.fulfill({ contentType: 'text/html', body: PAGE }))
  await page.goto('http://d2.test/')
  const cdp = await context.newCDPSession(page)
  const frames: Frame[] = []
  let meta: Record<string, unknown> | null = null
  cdp.on('Page.screencastFrame', (e: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    meta ??= e.metadata
    const i = frames.length
    const file = join(dir, `f${String(i).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(e.data, 'base64'))
    frames.push({ i, ts: (e.metadata.timestamp ?? NaN) * 1000, recvMs: Date.now(), file })
    void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 90,
    maxWidth: VIEW.width * DPR,
    maxHeight: VIEW.height * DPR,
    everyNthFrame: 1,
  })
  const started = Date.now()
  // Drive: a Lissajous mouse path with wheel scrolling, and a click every SECONDS/FLASHES seconds.
  let nextClick = started + 800
  let clicks = 0
  while (Date.now() - started < SECONDS * 1000) {
    const t = (Date.now() - started) / 1000
    const x = VIEW.width / 2 + Math.sin(t * 1.3) * 400
    const y = VIEW.height / 2 + Math.sin(t * 0.9) * 250
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, 40)
    if (Date.now() >= nextClick && clicks < FLASHES) {
      await page.mouse.down()
      await page.mouse.up()
      clicks++
      nextClick = Date.now() + (SECONDS * 1000 - 1600) / FLASHES
    }
    await new Promise((r) => setTimeout(r, 16))
  }
  await cdp.send('Page.stopScreencast')
  await new Promise((r) => setTimeout(r, 300))
  const trace = (await page.evaluate('window.__trace')) as { t: number; type: string; k?: number }[]
  const dprOf = await page.evaluate('window.devicePixelRatio')
  await browser.close()

  // Box colour per frame: crop the box (CSS px * dpr, minus a margin against JPEG ringing), average to 1x1 RGB.
  const [fw, fh] = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', frames[0]!.file], { encoding: 'utf8' })
    .stdout.trim()
    .split(',')
    .map(Number) as [number, number]
  const px = Math.round((BOX * fw) / VIEW.width)
  const crop = `crop=${px - 20}:${px - 20}:10:10,scale=1:1:flags=area`
  const rgb = spawnSync('ffmpeg', ['-loglevel', 'error', '-framerate', '30', '-i', join(dir, 'f%05d.jpg'), '-vf', crop, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout
  const colourOf = (i: number) => {
    const px = [rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!]
    let best = -1
    let bestD = Infinity
    COLOURS.forEach((c, k) => {
      const d = Math.hypot(c[0] - px[0]!, c[1] - px[1]!, c[2] - px[2]!)
      if (d < bestD) [best, bestD] = [k, d]
    })
    return bestD < 80 ? best : -1
  }

  // Frame clock: fps, gaps, monotonicity.
  const ts = frames.map((f) => f.ts)
  const gaps = ts.slice(1).map((t, i) => t - ts[i]!)
  const backwards = gaps.filter((g) => g <= 0).length
  const durS = (ts.at(-1)! - ts[0]!) / 1000
  const perSecond: number[] = []
  for (let s = Math.floor(ts[0]! / 1000); s < Math.floor(ts.at(-1)! / 1000); s++)
    perSecond.push(ts.filter((t) => t >= s * 1000 && t < (s + 1) * 1000).length)
  // Click -> first frame showing that click's colour (after the click's own time, and before the next click).
  const downs = trace.filter((e) => e.type === 'down')
  const offsets: number[] = []
  const recvOffsets: number[] = []
  downs.forEach((d, n) => {
    const nextT = downs[n + 1]?.t ?? Infinity
    const hit = frames.find((f) => colourOf(f.i) === d.k && f.ts > d.t - 1000 && f.ts < nextT + 1000)
    if (hit) {
      offsets.push(hit.ts - d.t)
      recvOffsets.push(hit.recvMs - d.t)
    }
    log('flash', { mode, n, k: d.k, clickT: round(d.t, 2), frameTs: hit ? round(hit.ts, 2) : null, offsetMs: hit ? round(hit.ts - d.t, 2) : null })
  })
  const moves = trace.filter((e) => e.type === 'move').map((e) => e.t)
  const moveGaps = moves.slice(1).map((t, i) => t - moves[i]!)
  const q = (xs: number[], p: number) => {
    const v = quantile(xs, p)
    return v === null ? null : round(v, 1)
  }
  const result = {
    frames: frames.length,
    durationS: round(durS, 2),
    fps: { mean: round((frames.length - 1) / durS, 1), median: q(perSecond, 0.5), p10: q(perSecond, 0.1), min: Math.min(...perSecond) },
    frameGapMs: { median: q(gaps, 0.5), p90: q(gaps, 0.9), max: q(gaps, 1) },
    backwards,
    frameSize: { width: fw, height: fh },
    firstMetadata: meta,
    devicePixelRatio: dprOf,
    pointer: { moves: moves.length, medianGapMs: q(moveGaps, 0.5) },
    clockOffset: {
      clicks: downs.length,
      matched: offsets.length,
      // Frame ts minus click time: includes the paint latency (the box can only appear on the next composited frame).
      medianMs: q(offsets, 0.5),
      p10Ms: q(offsets, 0.1),
      p90Ms: q(offsets, 0.9),
      spreadMs: offsets.length ? round(Math.max(...offsets) - Math.min(...offsets), 1) : null,
      minMs: q(offsets, 0),
      maxMs: q(offsets, 1),
      receivedMinusClickMedianMs: q(recvOffsets, 0.5),
    },
  }
  log('mode', { mode, ...result })
  return result
}

const summary: Record<string, unknown> = { env: { platform: platform(), arch: arch(), cpus: availableParallelism(), chromium: chromium.name() } }
for (const mode of modes) summary[mode] = await run(mode)
printSummary('D2', join(outDir, 'summary.json'), summary)
