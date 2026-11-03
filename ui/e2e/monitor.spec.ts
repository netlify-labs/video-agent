// The stem monitor on the mock build's /dev/clock page (plan 2026-11-02 §5.3 Monitor mix): a take recorded while the
// monitor plays, with the stand-in mic (window.__vaTestMic) fed back from the monitor's output (a loopback through
// window.__vaTestMicTap), so the take holds exactly what the person would hear. The demo's stems are tones (music
// 220 Hz, AI voice 1 kHz): in replace mode the take must not correlate with the AI voice stem, in keep mode it must.
import { expect, test, type Page } from '@playwright/test'

/** The stand-in mic: an empty mono stream whose input the demo connects the monitor to (page script). */
const LOOPBACK_MIC = `
window.__vaTestMic = (ctx) => {
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  window.__vaTestMicTap = dest
  return dest.stream
}`

/**
 * Normalized cross-correlation of the take (24 kHz PCM16 WAV) against a stem, best over 4.6 ms of lags (a period of either tone), in 0.4 s
 * windows every 0.2 s from 0.3 s on: about 1 where the take is that stem, about 0 where it isn't in it. `voice` and
 * `music` are each the best window (so how late the picture or the monitor started doesn't matter); `musicAtVoice` is
 * the music in the AI voice's best window.
 */
const CORRELATE = `(async () => {
  const buf = await window.__vaMonitorTake.wav.arrayBuffer()
  const pcm = new Int16Array(buf, 44)
  const x = Float32Array.from(pcm, (v) => v / 32768)
  const n = Math.round(0.4 * 24000)
  const corr = (from, ref) => {
    let xx = 0
    for (let i = 0; i < n; i++) xx += x[from + i] ** 2
    let best = 0
    for (let lag = 0; lag < 110; lag++) {
      let xy = 0, rr = 0
      for (let i = 0; i < n; i++) {
        const r = ref[lag + i]
        xy += x[from + i] * r
        rr += r * r
      }
      best = Math.max(best, Math.abs(xy) / Math.sqrt(xx * rr || 1))
    }
    return best
  }
  const stems = window.__vaMonitorStems
  let at = 0, voice = -1, music = 0
  for (let from = Math.round(0.3 * 24000); from + n <= x.length; from += 4800) {
    const v = corr(from, stems['assets/voice/intro.wav'])
    if (v > voice) { voice = v; at = from }
    music = Math.max(music, corr(from, stems['assets/media/music.wav']))
  }
  let xx = 0
  for (let i = 0; i < n; i++) xx += x[at + i] ** 2
  return {
    samples: x.length,
    at: at / 24000,
    rms: Math.sqrt(xx / n),
    voice,
    music,
    musicAtVoice: corr(at, stems['assets/media/music.wav']),
  }
})()`

interface Correlation {
  samples: number
  /** Where the best voice window starts in the take, in seconds. */
  at: number
  rms: number
  voice: number
  music: number
  musicAtVoice: number
}

async function recordTake(page: Page, mode: string): Promise<Correlation> {
  await page.addInitScript({ content: LOOPBACK_MIC })
  await page.goto('/dev/clock')
  await page.getByRole('button', { name: /^Open the monitor/ }).click()
  await expect(page.getByRole('heading', { name: /^Monitor mix/ })).toBeVisible()
  await page.getByText(mode, { exact: true }).click()
  await page.getByRole('button', { name: 'Arm', exact: true }).click()
  await expect(page.getByTestId('monitor-phase')).toHaveText('armed', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Record with monitor' }).click()
  await expect(page.getByTestId('monitor-phase')).toHaveText('recording')
  await expect
    .poll(() => page.evaluate<number>("document.querySelector('[data-testid=monitor-video]').currentTime"), {
      timeout: 10_000,
    })
    .toBeGreaterThan(2.6)
  const running = JSON.parse((await page.getByTestId('monitor-stats').textContent()) ?? '{}') as {
    running: boolean
    stems: { id: string; loaded: boolean }[]
  }
  expect(running.running).toBe(true)
  expect(running.stems.every((s) => s.loaded)).toBe(true)
  await page.getByRole('button', { name: 'End take' }).click()
  await expect(page.getByTestId('monitor-phase')).toHaveText('stopped', { timeout: 10_000 })
  const c = await page.evaluate<Correlation>(CORRELATE)
  // One structured line per take, so a failure shows how far off it was.
  console.info(JSON.stringify({ event: 'monitor.correlation', mode, ...c }))
  return c
}

test('monitor: a replace-mode take has no AI-voice bleed, only the music', async ({ page }) => {
  const c = await recordTake(page, 'Replace AI voice')
  expect(c.samples).toBeGreaterThan(2.4 * 24_000)
  expect(c.rms).toBeGreaterThan(0.02)
  // No window anywhere in the take holds the AI voice; the music is there.
  expect(c.voice).toBeLessThan(0.1)
  expect(c.music).toBeGreaterThan(0.8)
  const stats = JSON.parse((await page.getByTestId('monitor-stats').textContent()) ?? '{}') as {
    stems: { id: string; role: string }[]
  }
  expect(stats.stems.map((s) => s.role)).toEqual(['music'])
})

test('monitor: a keep-mode take carries the AI voice the monitor played', async ({ page }) => {
  const c = await recordTake(page, 'Keep AI voice')
  expect(c.voice).toBeGreaterThan(0.8)
  // The music is pre-ducked under the AI voice, so it is a small part of the take there.
  expect(c.musicAtVoice).toBeLessThan(0.3)
})
