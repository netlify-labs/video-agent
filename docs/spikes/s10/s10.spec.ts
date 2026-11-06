// Spike S10, automated part. Chromium with a fake mic (media/fake-mic.wav: 2 kHz beeps every 2.000 s) verifies the
// pipeline end to end: sample counts, worker hash = one-shot hash of the final WAV = server hash, peaks dims,
// IndexedDB recovery after a reload, the fit and the report, stop conditions, the audition budget, and the
// pipeline's own consistency (captured beep spacing vs the file's). It can't measure real latency: that is the owner
// hardware matrix (CHECKLIST.md). Every page report lands in docs/spikes/s10/out/ for analyze.ts.
import { expect, test, type Page } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectOnsets } from './lib/onsets.js'
import { Resampler } from './lib/resample.js'
import { Sha256 } from './lib/sha256.js'
import { mediaDir, outDir, startServer } from './server.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type R = Record<string, any>

let srv: Awaited<ReturnType<typeof startServer>>
const summary: R = {}
test.beforeAll(async () => {
  if (!existsSync(join(mediaDir, 'manifest.json'))) throw new Error('run docs/spikes/s10/make-media.sh first')
  srv = await startServer()
})
test.afterAll(({ browserName }) => {
  srv.close()
  if (Object.keys(summary).length)
    writeFileSync(
      join(outDir, `automated-${browserName}${process.env.S10_LONG ? '-long' : ''}.json`),
      JSON.stringify(summary, null, 1),
    )
})

const s10 = <T = R>(page: Page, call: string) => page.evaluate<T>(`window.__s10.${call}`)
async function open(page: Page, qs = 'mode=fake&label=chromium%20%2F%20fake-mic%20%2F%20automation') {
  page.on('console', (m) => {
    if (m.type() === 'error' || process.env.S10_DEBUG) console.log('[page]', m.type(), m.text().slice(0, 400))
  })
  await page.goto(`${srv.origin}/?${qs}`)
  await page.waitForFunction('!!window.__s10')
}
// S10_MIC=device uses Chromium's fake capture device (playwright.config args); the default 'synthetic' loops the
// same WAV in-page because the fake device's getUserMedia never resolves on the macOS agent host (see page.ts).
const MIC = process.env.S10_MIC === 'device' ? 'device' : 'synthetic'
const FAKE = { ec: false, ns: false, agc: false, mode: 'fake', mic: MIC }

test('lib: streaming SHA-256, resampler, onset detector', ({ browserName }) => {
  test.skip(browserName !== 'chromium')
  for (const n of [0, 1, 55, 64, 65, 4097, 100_003]) {
    const d = randomBytes(n)
    const h = new Sha256()
    for (let i = 0; i < n; i += 997) h.update(d.subarray(i, i + 997))
    expect(h.hex()).toBe(createHash('sha256').update(d).digest('hex'))
  }
  const res: R = {}
  for (const inRate of [48_000, 44_100]) {
    const x = new Float32Array(inRate * 2).map(
      (_, i) =>
        0.5 * Math.sin((2 * Math.PI * 1000 * i) / inRate) +
        0.3 * Math.sin((2 * Math.PI * 15_000 * i) / inRate),
    )
    const r = new Resampler(inRate, 24_000)
    const parts = [] as Float32Array[]
    for (let i = 0; i < x.length; i += 2048) parts.push(r.push(x.subarray(i, i + 2048)))
    parts.push(r.finish())
    const y = Float32Array.from(parts.flatMap((p) => [...p]))
    expect(y.length).toBe(Math.ceil((x.length * 24_000) / inRate))
    let err = 0
    let sig = 0
    for (let j = 100; j < y.length - 100; j++) {
      const ref = 0.5 * Math.sin((2 * Math.PI * 1000 * j) / 24_000)
      err += ((y[j] ?? 0) - ref) ** 2
      sig += ref ** 2
    }
    res[inRate] = 10 * Math.log10(err / sig)
    expect(res[inRate]).toBeLessThan(-60) // the 15 kHz tone is gone and 1 kHz is intact
  }
  const sr = 24_000
  const x = new Float32Array(sr * 6)
  const at = [12_345, 50_000, 100_001]
  for (const s of at) for (let i = 0; i < 1200; i++) x[s + i] = 0.5 * Math.sin((2 * Math.PI * 2000 * i) / sr)
  for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) + 0.06 * Math.sin((2 * Math.PI * 220 * i) / sr)
  const on = detectOnsets(x, { sampleRate: sr }).map((o) => o.sample - (at.shift() ?? 0))
  expect(on.every((d) => Math.abs(d) <= 2)).toBe(true)
  summary.lib = { resamplerErrorDb: res, onsetBiasSamples: on }
})

test('@matrix API matrix prints', async ({ page, browserName }) => {
  await open(page)
  const m = await s10(page, 'matrix()')
  await expect(page.locator('#matrixTable')).toContainText('requestVideoFrameCallback')
  summary.matrix = m
  console.log(`[matrix ${browserName}]`, JSON.stringify(m))
})

test('30 s take end to end with the fake mic', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await s10(page, 'clear()')
  const r = await s10(page, `take(${JSON.stringify({ ...FAKE, media: 30, mediaRecorder: true })})`)
  console.log(
    '[take30]',
    JSON.stringify({
      stop: r.stop,
      capture: r.capture,
      timings: r.timings,
      verify: r.verify,
      upload: r.upload,
      peaks: r.peaks,
      fit: r.fit,
      clocks: r.clocks,
      monitor: r.monitor,
      fake: r.fake,
      mediaRecorder: r.mediaRecorder,
    }),
  )
  expect(r.stop.reason).toBe('ended')
  expect(r.capture.samplesMatch).toBe(true)
  expect(Math.abs(r.capture.samples - 30 * 24_000)).toBeLessThan(0.5 * 24_000)
  expect(r.verify.fileHashMatch).toBe(true)
  expect(r.verify.pcmHashMatch).toBe(true)
  expect(r.verify.runningHashInRecord).toBe(true)
  expect(r.upload.matchesWorkerFileHash).toBe(true)
  expect(r.verify.peaks.dimsOk).toBe(true)
  expect(r.verify.peaks.maxDiffVsRecomputed).toBeLessThanOrEqual(1)
  expect(r.verify.decodable).toBe(true)
  expect(r.fit.n).toBeGreaterThan(600)
  expect(r.fake.beepsDetected).toBeGreaterThanOrEqual(13)
  expect(r.savedAs).toBeTruthy()
  summary.take30 = r
})

test('IndexedDB recovery after a reload mid-take', async ({ page }) => {
  await open(page)
  await s10(page, 'clear()')
  void s10(page, `take(${JSON.stringify({ ...FAKE, media: 30, mediaRecorder: false })})`).catch(
    () => undefined,
  )
  await expect
    .poll(async () => ((await s10<R[]>(page, 'recoverable()'))[0]?.samples as number | undefined) ?? 0, {
      timeout: 20_000,
    })
    .toBeGreaterThan(5 * 24_000)
  const before = (await s10<R[]>(page, 'recoverable()'))[0] as R
  await page.reload()
  await page.waitForFunction('!!window.__s10')
  const list = await s10<R[]>(page, 'recoverable()')
  expect(list).toHaveLength(1)
  const take = list[0] as R
  expect(take.status).toBe('recording')
  expect(take.samples).toBeGreaterThanOrEqual(before.samples)
  const rec = await s10(page, `recover(${JSON.stringify(take.id)})`)
  console.log('[recovery]', JSON.stringify(rec))
  expect(rec.runningHashOk).toBe(true)
  expect(rec.samples).toBe(take.samples)
  expect(rec.fitSaved).toBe(true)
  summary.recovery = rec
})

test('stop conditions: seek, hidden tab, devicechange, track ended, residual', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const quick = { ...FAKE, media: 30, mediaRecorder: false, persist: false, upload: false }
  const triggers: [string, string, R][] = [
    ['seek', `document.getElementById('video').currentTime = 12`, {}],
    [
      'hidden',
      `Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'))`,
      {},
    ],
    ['devicechange', `navigator.mediaDevices.dispatchEvent(new Event('devicechange'))`, {}],
    ['track-ended', `window.__s10.endTrack()`, {}],
    ['residual', '', { thresholdMs: 0.01 }],
  ]
  const got: R = {}
  for (const [want, js, extra] of triggers) {
    const p = s10(page, `take(${JSON.stringify({ ...quick, ...extra })})`)
    await page.waitForFunction('window.__s10.running()')
    await page.waitForTimeout(3000)
    if (js) await page.evaluate(js)
    const r = await p
    if (want === 'hidden')
      await page.evaluate(
        `Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })`,
      )
    got[want] = {
      reason: r.stop.reason,
      atSeconds: r.stop.atSeconds,
      cleanSamples: r.stop.cleanSamples,
      breach: r.stop.firstResidualBreach,
    }
    expect(r.stop.reason).toBe(want)
  }
  console.log('[stops]', JSON.stringify(got))
  summary.stops = got
})

test('calibration code paths (fake mic: numbers are not latency)', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const a = await s10(page, `calibrateLoopback(${JSON.stringify(FAKE)})`)
  const b = await s10(page, `calibrateClap(${JSON.stringify(FAKE)})`)
  console.log(
    '[calib]',
    JSON.stringify({
      a: a.result,
      aDetected: a.detected,
      b: b.result,
      out: a.impliedOutputLatencyMs,
      reported: a.reportedOutputPlusBaseMs,
    }),
  )
  expect(b.claps).toBeGreaterThan(0)
  summary.calibration = { a, b }
})

test('multi-take audition under the 200 MB decode budget', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const r = await s10(page, 'audition({ takes: 32, active: 8, seconds: 600, budgetMB: 200 })')
  console.log('[audition]', JSON.stringify(r))
  expect(r.withinBudget).toBe(true)
  summary.audition = r
})

test('10-minute take (S10_LONG=1)', async ({ page }) => {
  test.skip(!process.env.S10_LONG, 'set S10_LONG=1')
  test.setTimeout(15 * 60_000)
  await open(page)
  await s10(page, 'clear()')
  const r = await s10(
    page,
    `take(${JSON.stringify({ ...FAKE, media: 600, mediaRecorder: true, residualRun: Number(process.env.S10_RESIDUAL_RUN ?? 3) })})`,
  )
  console.log(
    '[take600]',
    JSON.stringify({
      stop: r.stop,
      capture: r.capture,
      timings: r.timings,
      verify: r.verify,
      upload: r.upload,
      fit: r.fit,
      clocks: r.clocks,
      monitor: r.monitor,
      fake: r.fake,
      mediaRecorder: r.mediaRecorder,
      memory: r.memory,
    }),
  )
  expect(r.verify.fileHashMatch).toBe(true)
  summary.take600 = r
})
