// Spike D4 (plan 2026-11-04-screen-recording-demo §4.3, §4.5, §10 Phase 0): H.264 encoding in the browser with
// Mediabunny, live (path B) and as a conversion (path C), in Chromium, WebKit and Firefox (Playwright builds).
//   npx tsx docs/spikes/d4/encode.ts --mediabunny <dir with mediabunny.min.mjs> [--out /tmp/va-d4]
//        [--browsers chromium,webkit,firefox] [--live-seconds 60] [--convert-input <5-min 1440p H.264 mp4>]
//        [--tests live,convert] [--latency realtime|quality]
// Live: an animated 2560x1440 source canvas (text rows, a moving cursor, a frame counter) stands in for the display
// track (getDisplayMedia can't be granted headless in every browser). Variants:
//   canvas  the path B pipeline: source track -> <video> -> a canvas at the FIRST frame's size, redrawn every rAF ->
//           canvas.captureStream(30) -> MediaStreamVideoTrackSource (avc, 3.5 Mbps, keyFrameInterval 1)
//   direct  the source track straight into MediaStreamVideoTrackSource with sizeChangeBehavior 'contain'
// Halfway through, the source canvas resizes to 2000x1300 (a window resize). Conversion: the input as MOV (remuxed)
// and WebM (VP9), converted to H.264 MP4 (fastStart in-memory, keyFrameInterval 1, 3.5 Mbps) on the main thread and
// in a module Worker. Every output gets the §4.2 checks with ffprobe here (codec, size, longest keyframe gap, frame
// durations, fast start, fragments). JSON lines on stderr, a summary between ===D4-JSON=== lines.
import { spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit, type BrowserType } from 'playwright'
import { log, parseFlags, printSummary, quantile, round } from '../lib/proc.js'

const flags = parseFlags(process.argv.slice(2))
const outDir = flags.out ?? join(tmpdir(), 'va-d4')
const mbDir = flags.mediabunny
if (!mbDir) throw new Error('--mediabunny <dir containing mediabunny.min.mjs> is required')
const browsers = (flags.browsers ?? 'chromium,webkit,firefox').split(',')
const tests = (flags.tests ?? 'live,convert').split(',')
const LIVE_S = Number(flags['live-seconds'] ?? 60)
const BITRATE = 3_500_000
// WebCodecs latencyMode for the CanvasSource fallback: 'realtime' lets the encoder drop frames (Firefox does).
const LATENCY = flags.latency === 'quality' ? 'quality' : 'realtime'
mkdirSync(outDir, { recursive: true })
const TYPES: Record<string, BrowserType> = { chromium, webkit, firefox }
let closeServer = () => {}

// ---------- Inputs for conversion ----------

function convertInputs() {
  const src = flags['convert-input']
  if (!src || !existsSync(src)) return []
  const mov = join(outDir, 'input.mov')
  const webm = join(outDir, 'input.webm')
  if (!existsSync(mov)) spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-c', 'copy', mov])
  if (!existsSync(webm))
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '3M', '-c:a', 'libopus', webm])
  return [
    { name: 'mov', file: mov, type: 'video/quicktime' },
    { name: 'webm', file: webm, type: 'video/webm' },
  ].filter((i) => existsSync(i.file))
}

// ---------- §4.2 checks ----------

function check(file: string) {
  const p = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }).stdout || '{}') as {
    streams?: { codec_type: string; codec_name: string; width: number; height: number; avg_frame_rate: string; r_frame_rate: string; nb_frames?: string }[]
    format?: { duration: string }
  }
  const v = p.streams?.find((s) => s.codec_type === 'video')
  const pk = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time,flags', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.trim().split('\n').filter(Boolean)
  const pts: number[] = []
  const keys: number[] = []
  const durs: number[] = []
  for (const line of pk) {
    const [t, d, f] = line.split(',')
    pts.push(Number(t))
    durs.push(Number(d))
    if (f?.includes('K')) keys.push(Number(t))
  }
  pts.sort((a, b) => a - b)
  keys.sort((a, b) => a - b)
  const gaps = keys.slice(1).map((k, i) => k - keys[i]!)
  const deltas = pts.slice(1).map((t, i) => round((t - pts[i]!) * 1000, 2))
  const distinct = [...new Set(deltas.map((d) => Math.round(d)))].sort((a, b) => a - b)
  // Top-level boxes: fast start = moov before mdat; fragmented = any moof.
  const buf = readFileSync(file)
  const boxes: string[] = []
  for (let at = 0; at + 8 <= buf.length && boxes.length < 64; ) {
    let size = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    if (size === 1) size = Number(buf.readBigUInt64BE(at + 8))
    boxes.push(type)
    if (size < 8) break
    at += size
  }
  const durationS = Number(p.format?.duration)
  return {
    codec: v?.codec_name ?? null,
    size: v ? `${v.width}x${v.height}` : null,
    durationS: round(durationS, 2),
    bytes: statSync(file).size,
    mbps: round((statSync(file).size * 8) / durationS / 1e6, 2),
    frames: pts.length,
    avgFps: v?.avg_frame_rate ?? null,
    keyframes: keys.length,
    maxKeyGapS: gaps.length ? round(Math.max(...gaps), 3) : null,
    frameDeltaMs: { median: quantile(deltas, 0.5), p95: quantile(deltas, 0.95), max: deltas.length ? Math.max(...deltas) : null, distinctRounded: distinct.slice(0, 12) },
    boxes: boxes.slice(0, 8),
    fastStart: boxes.indexOf('moov') >= 0 && boxes.indexOf('moov') < boxes.indexOf('mdat'),
    fragmented: boxes.includes('moof'),
    pass42: {
      h264: v?.codec_name === 'h264',
      keyGapUnder2s: gaps.length ? Math.max(...gaps) <= 2 : keys.length === pts.length,
      fastStart: boxes.indexOf('moov') >= 0 && boxes.indexOf('moov') < boxes.indexOf('mdat'),
      notFragmented: !boxes.includes('moof'),
      // CFR: every frame lasts the same (to the ms), as stts would show one entry.
      constantFrameRate: distinct.length <= 1,
    },
  }
}

// ---------- The page ----------

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>d4</title></head><body style="margin:0;background:#000">
<canvas id="src" width="2560" height="1440" style="width:320px"></canvas>
<script type="module">
import * as MB from '/mb.mjs'
window.MB = MB
const LATENCY = '${LATENCY}'
const src = document.getElementById('src')
const ctx = src.getContext('2d')
let n = 0, running = true
function draw() {
  if (!running) return
  const { width: w, height: h } = src
  ctx.fillStyle = '#f4f5f7'; ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#111'; ctx.font = '28px system-ui'
  for (let r = 0; r < 40; r++) ctx.fillText('Row ' + r + '  deploy-preview-' + ((r * 7919) % 1000) + '  build log line ' + (n % 97), 80, 60 + r * 34)
  ctx.fillStyle = '#14b8a6'; ctx.fillRect(w - 420, 40, 360, 120)
  ctx.fillStyle = '#000'; ctx.font = 'bold 64px monospace'; ctx.fillText(String(n), w - 400, 130)
  const x = w / 2 + Math.sin(n / 40) * w * 0.35, y = h / 2 + Math.sin(n / 53) * h * 0.35
  ctx.fillStyle = '#e11d48'; ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.fill()
  n++
  requestAnimationFrame(draw)
}
requestAnimationFrame(draw)

window.support = async () => {
  const out = { webcodecs: typeof VideoEncoder !== 'undefined', captureStream: typeof src.captureStream === 'function' }
  try { out.avc = await MB.canEncodeVideo('avc', { width: 2560, height: 1440, bitrate: ${BITRATE} }) } catch (e) { out.avc = 'error: ' + e.message }
  try { out.isConfigSupported = (await VideoEncoder.isConfigSupported({ codec: 'avc1.640033', width: 2560, height: 1440, bitrate: ${BITRATE}, framerate: 30 })).supported } catch (e) { out.isConfigSupported = 'error: ' + e.message }
  out.mediaRecorderMp4 = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')
  out.mediaRecorderWebm = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
  return out
}

async function upload(name, buf) {
  await fetch('/upload/' + name, { method: 'POST', body: buf })
}

// Fallback for browsers that can't hand a track to Mediabunny's worker: draw the display <video> into a canvas at the
// first frame's size and add a frame every 1/30 s of wall clock with CanvasSource (explicit CFR timestamps).
async function liveCanvasSource(seconds) {
  src.width = 2560; src.height = 1440
  const srcTrack = src.captureStream(30).getVideoTracks()[0]
  const video = document.createElement('video')
  video.muted = true; video.srcObject = new MediaStream([srcTrack]); await video.play()
  while (!video.videoWidth) await new Promise((r) => setTimeout(r, 10))
  const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight
  const cx = c.getContext('2d')
  const target = new MB.BufferTarget()
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const source = new MB.CanvasSource(c, { codec: 'avc', bitrate: ${BITRATE}, keyFrameInterval: 1, latencyMode: LATENCY })
  output.addVideoTrack(source, { frameRate: 30 })
  await output.start()
  const t0 = performance.now()
  let k = 0, late = 0, resized = false, error = null
  while ((performance.now() - t0) / 1000 < seconds) {
    const due = t0 + (k * 1000) / 30
    const wait = due - performance.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    else if (wait < -1000 / 30) late++
    if (!resized && performance.now() - t0 > seconds * 500) { src.width = 2000; src.height = 1300; resized = true }
    const s = Math.min(c.width / video.videoWidth, c.height / video.videoHeight)
    const dw = video.videoWidth * s, dh = video.videoHeight * s
    cx.fillStyle = '#000'; cx.fillRect(0, 0, c.width, c.height)
    cx.drawImage(video, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh)
    try { await source.add(k / 30, 1 / 30) } catch (e) { error = String(e && e.message || e); break }
    k++
  }
  const elapsed = (performance.now() - t0) / 1000
  const tf = performance.now()
  try { await output.finalize() } catch (e) { error = error || String(e && e.message || e) }
  srcTrack.stop()
  if (target.buffer) await upload('live-canvassource', target.buffer)
  return { variant: 'canvassource', elapsedS: elapsed, finalizeMs: performance.now() - tf, bytes: target.buffer ? target.buffer.byteLength : 0, added: k, lateFrames: late, error }
}

window.live = async (variant, seconds) => {
  if (variant === 'canvassource') return liveCanvasSource(seconds).catch((e) => ({ variant, error: 'threw: ' + String(e && e.message || e) }))
  try { return await liveIn(variant, seconds) } catch (e) { return { variant, error: 'threw: ' + String(e && e.message || e) } } }
async function liveIn(variant, seconds) {
  src.width = 2560; src.height = 1440
  const srcTrack = src.captureStream(30).getVideoTracks()[0]
  let track = srcTrack, stopCopy = () => {}, copied = 0, rafs = 0
  if (variant === 'canvas') {
    // Path B: the display track drawn to a canvas at the first frame's size, every rAF.
    const video = document.createElement('video')
    video.muted = true; video.srcObject = new MediaStream([srcTrack]); await video.play()
    while (!video.videoWidth) await new Promise((r) => setTimeout(r, 10))
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight
    const cx = c.getContext('2d')
    let on = true
    const loop = () => {
      if (!on) return
      rafs++
      // Contain the (possibly resized) frame in the first frame's box.
      const s = Math.min(c.width / video.videoWidth, c.height / video.videoHeight)
      const dw = video.videoWidth * s, dh = video.videoHeight * s
      cx.fillStyle = '#000'; cx.fillRect(0, 0, c.width, c.height)
      cx.drawImage(video, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh)
      copied++
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    stopCopy = () => { on = false }
    track = c.captureStream(30).getVideoTracks()[0]
  }
  const target = new MB.BufferTarget()
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const source = new MB.MediaStreamVideoTrackSource(track, { codec: 'avc', bitrate: ${BITRATE}, keyFrameInterval: 1, sizeChangeBehavior: variant === 'direct' ? 'contain' : 'deny', latencyMode: 'realtime' }, { frameRate: 30 })
  let error = null
  source.errorPromise.catch((e) => { error = String(e && e.message || e) })
  output.addVideoTrack(source, { frameRate: 30 })
  const t0 = performance.now()
  await output.start()
  await new Promise((r) => setTimeout(r, seconds * 500))
  src.width = 2000; src.height = 1300
  await new Promise((r) => setTimeout(r, seconds * 500))
  const elapsed = (performance.now() - t0) / 1000
  stopCopy()
  const tf = performance.now()
  try { await output.finalize() } catch (e) { error = error || String(e && e.message || e) }
  const finalizeMs = performance.now() - tf
  track.stop(); srcTrack.stop()
  if (target.buffer) await upload('live-' + variant, target.buffer)
  return { variant, elapsedS: elapsed, finalizeMs, bytes: target.buffer ? target.buffer.byteLength : 0, copied, rafs, error }
}

async function convertIn(inputUrl) {
  const blob = await (await fetch(inputUrl)).blob()
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS })
  const duration = await input.computeDuration()
  const target = new MB.BufferTarget()
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const conversion = await MB.Conversion.init({ input, output, video: { codec: 'avc', bitrate: ${BITRATE}, keyFrameInterval: 1, frameRate: 30, forceTranscode: true }, audio: { discard: true } })
  if (!conversion.isValid) return { error: 'invalid: ' + JSON.stringify(conversion.discardedTracks.map((d) => d.reason)) }
  const t0 = performance.now()
  await conversion.execute()
  return { ms: performance.now() - t0, duration, buffer: target.buffer }
}
window.convertIn = convertIn

window.convert = async (name, inputUrl, worker) => {
  try {
    let r
    if (worker) {
      const w = new Worker('/worker.mjs', { type: 'module' })
      r = await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => res({ error: 'worker: ' + (e.message || 'error') }); w.postMessage({ inputUrl }) })
      w.terminate()
    } else r = await convertIn(inputUrl)
    if (r.error) return { name, worker, error: r.error }
    await upload('convert-' + name + (worker ? '-worker' : ''), r.buffer)
    return { name, worker, ms: r.ms, durationS: r.duration, realTimeFactor: r.ms / 1000 / r.duration, bytes: r.buffer.byteLength }
  } catch (e) { return { name, worker, error: String(e && e.message || e) } }
}
</script></body></html>`

const WORKER = `import * as MB from '/mb.mjs'
self.onmessage = async (e) => {
  try {
    const blob = await (await fetch(e.data.inputUrl)).blob()
    const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS })
    const duration = await input.computeDuration()
    const target = new MB.BufferTarget()
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target })
    const conversion = await MB.Conversion.init({ input, output, video: { codec: 'avc', bitrate: ${BITRATE}, keyFrameInterval: 1, frameRate: 30, forceTranscode: true }, audio: { discard: true } })
    if (!conversion.isValid) return self.postMessage({ error: 'invalid' })
    const t0 = performance.now()
    await conversion.execute()
    self.postMessage({ ms: performance.now() - t0, duration, buffer: target.buffer }, [target.buffer])
  } catch (err) { self.postMessage({ error: String(err && err.message || err) }) }
}`

// ---------- Driver ----------

async function runBrowser(name: string, inputs: { name: string; file: string; type: string }[]) {
  const dir = join(outDir, name)
  mkdirSync(dir, { recursive: true })
  // A real server, not page.route: routing 140-320 MB bodies through Playwright crashed the page.
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const send = (type: string, body: string) => res.writeHead(200, { 'content-type': type }).end(body)
    if (path === '/') return send('text/html', PAGE)
    if (path === '/worker.mjs') return send('text/javascript', WORKER)
    if (path === '/mb.mjs') return createReadStream(join(mbDir!, 'mediabunny.min.mjs')).pipe(res.writeHead(200, { 'content-type': 'text/javascript' }))
    const input = inputs.find((i) => path === `/input/${i.name}`)
    if (input) return createReadStream(input.file).pipe(res.writeHead(200, { 'content-type': input.type, 'content-length': statSync(input.file).size }))
    if (path.startsWith('/upload/') && req.method === 'POST') {
      const out = createWriteStream(join(dir, `${path.slice(8)}.mp4`))
      req.pipe(out)
      return out.on('finish', () => res.writeHead(204).end())
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(4747, 'localhost', r))
  closeServer = () => {
    server.closeAllConnections()
    server.close()
  }
  const browser = await TYPES[name]!.launch({ headless: true })
  const page = await (await browser.newContext()).newPage()
  page.setDefaultTimeout(0)
  page.on('console', (m) => m.type() === 'error' && log('console', { browser: name, text: m.text().slice(0, 300) }))
  page.on('pageerror', (e) => log('pageerror', { browser: name, text: e.message.slice(0, 300) }))
  await page.goto('http://localhost:4747/')
  await page.waitForFunction("'MB' in window", undefined, { timeout: 30_000 })
  const result: Record<string, unknown> = { version: browser.version(), support: await page.evaluate('support()') }
  log('support', { browser: name, ...(result.support as object) })
  if (tests.includes('live'))
    for (const variant of ['canvas', 'direct', 'canvassource']) {
      const r = (await page.evaluate(`live(${JSON.stringify(variant)}, ${LIVE_S})`)) as { elapsedS: number; error: string | null }
      const file = join(dir, `live-${variant}.mp4`)
      const c = existsSync(file) && statSync(file).size > 0 ? check(file) : null
      const expected = Math.round(r.elapsedS * 30)
      result[`live-${variant}`] = { ...r, check: c, expectedFrames: expected, droppedPct: c ? round((100 * Math.max(0, expected - c.frames)) / expected, 2) : null }
      log('live', { browser: name, variant, ...(result[`live-${variant}`] as object) })
    }
  if (tests.includes('convert'))
    for (const input of inputs)
      for (const worker of [false, true]) {
        const r = (await page.evaluate(`convert(${JSON.stringify(input.name)}, '/input/${input.name}', ${worker})`)) as { error?: string }
        const file = join(dir, `convert-${input.name}${worker ? '-worker' : ''}.mp4`)
        const c = !r.error && existsSync(file) ? check(file) : null
        result[`convert-${input.name}${worker ? '-worker' : ''}`] = { ...r, check: c }
        log('convert', { browser: name, input: input.name, worker, ...r, check: c ? c.pass42 : null })
      }
  await browser.close()
  closeServer()
  return result
}

const inputs = tests.includes('convert') ? convertInputs() : []
log('inputs', { inputs: inputs.map((i) => ({ name: i.name, bytes: statSync(i.file).size })) })
const summary: Record<string, unknown> = { env: { platform: platform(), arch: arch(), liveSeconds: LIVE_S, bitrate: BITRATE, mediabunny: JSON.parse(readFileSync(join(mbDir, '..', '..', 'package.json'), 'utf8')).version } }
for (const b of browsers) {
  try {
    summary[b] = await runBrowser(b, inputs)
  } catch (e) {
    summary[b] = { error: e instanceof Error ? e.message.slice(0, 800) : String(e) }
    log('browser_failed', { browser: b, error: summary[b] })
    closeServer()
  }
}
printSummary('D4-JSON', join(outDir, 'summary.json'), summary)
