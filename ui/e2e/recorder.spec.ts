// The voice-over recorder on the mock build's /dev/recorder page (plan 2026-11-02 §5.1). The mic is a stand-in
// (window.__vaTestMic: an oscillator gated one second on, one off, through a MediaStreamAudioDestinationNode), because
// Chromium's fake capture device never resolves getUserMedia on the macOS agent host (S10); everything from the
// source node on is the real chain: worklet -> worker -> 24 kHz PCM16 -> IndexedDB.
import { expect, test, type Page } from '@playwright/test'

/** The stand-in mic, as page script (the specs aren't typechecked against the DOM library). */
const TEST_MIC = `
window.__vaTestMic = (ctx) => {
  const osc = ctx.createOscillator()
  osc.frequency.value = 440
  const gate = ctx.createGain()
  const t = ctx.currentTime
  for (let i = 0; i < 240; i++) gate.gain.setValueAtTime(i % 2 === 0 ? 0.5 : 0, t + i)
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  osc.connect(gate).connect(dest)
  osc.start()
  return dest.stream
}`
const testMic = (page: Page) => page.addInitScript({ content: TEST_MIC })

interface TakeInfo {
  recordingId: string
  samples: number
  bytes: number
  sha256: string
  peaks: number
  speech: [number, number][]
  persisted: boolean
}
const takeInfo = async (page: Page) =>
  JSON.parse((await page.getByTestId('recorder-take').textContent()) ?? '{}') as TakeInfo

test.beforeEach(async ({ page }) => {
  await testMic(page)
  await page.goto('/dev/recorder')
  await expect(page.getByRole('heading', { name: 'Recorder' })).toBeVisible()
})

test('recorder: record and stop gives a 24 kHz PCM16 WAV whose hash, peaks and speech match', async ({ page }) => {
  await page.getByRole('button', { name: 'Record' }).click()
  await expect(page.getByTestId('recorder-phase')).toHaveText('recording')
  await expect(page.getByText(/captured [2-9]\.\d s/)).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByTestId('recorder-take')).toBeVisible()
  const t = await takeInfo(page)
  expect(t.persisted).toBe(true)
  expect(t.samples).toBeGreaterThan(2 * 24_000)
  expect(t.bytes).toBe(44 + 2 * t.samples)
  expect(t.peaks).toBeGreaterThan(16)
  expect(t.speech.length).toBeGreaterThanOrEqual(1)
  // The worker's file hash is the one-shot hash of the WAV it produced, and the header says 24 kHz mono PCM16.
  const check = await page.evaluate(async () => {
    const take = (globalThis as unknown as { __vaTake: { wav: Blob } }).__vaTake
    const buf = await take.wav.arrayBuffer()
    const d = await crypto.subtle.digest('SHA-256', buf)
    const dv = new DataView(buf)
    return {
      sha256: [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      rate: dv.getUint32(24, true),
      channels: dv.getUint16(22, true),
      bits: dv.getUint16(34, true),
    }
  })
  expect(check).toEqual({ sha256: t.sha256, rate: 24_000, channels: 1, bits: 16 })
})

test('recovery: a reload mid-take offers the take to its owner only, and Recover brings it back', async ({
  page,
}) => {
  await page.goto('/dev/recorder?user=usr_a')
  await page.getByRole('button', { name: 'Record' }).click()
  await expect(page.getByText(/captured [2-9]\.\d s/)).toBeVisible({ timeout: 10_000 })
  // The tab goes away mid-take.
  await page.reload()
  const prompt = page.getByTestId('recovery-prompt')
  await expect(prompt).toContainText('An unsaved recording')
  await expect(prompt).toContainText('recording was interrupted')

  // Another account on this browser is never offered it.
  await page.goto('/dev/recorder?user=usr_b')
  await expect(page.getByText('as usr_b')).toBeVisible()
  await expect(page.getByTestId('recovery-prompt')).toHaveCount(0)

  await page.goto('/dev/recorder?user=usr_a')
  await page.getByTestId('recovery-prompt').getByRole('button', { name: /^Recover/ }).click()
  await expect(page.getByTestId('recorder-take')).toBeVisible()
  const t = await takeInfo(page)
  expect(t.samples % 12_000).toBe(0) // whole chunks: up to the last one saved
  expect(t.samples).toBeGreaterThanOrEqual(24_000)
  expect(t.bytes).toBe(44 + 2 * t.samples)
  await expect(page.getByTestId('recovery-prompt')).toHaveCount(0)

  // Discard clears it for good.
  await page.reload()
  await page.getByTestId('recovery-prompt').getByRole('button', { name: /^Discard/ }).click()
  await expect(page.getByTestId('recovery-prompt')).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('as usr_a')).toBeVisible()
  await expect(page.getByTestId('recovery-prompt')).toHaveCount(0)
})
