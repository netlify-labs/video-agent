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

test('recorder: record and stop gives a 24 kHz PCM16 WAV whose hash, peaks and speech match', async ({
  page,
}) => {
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

  // Then it uploads as a narration take with its peaks, waits until ready, and the clip is saved.
  await expect(page.getByTestId('take-state')).toHaveText('saved')
  const clip = await page.getByTestId('saved-clip').textContent()
  const mediaId = /clip (med_\w+) (\d+) samples/.exec(clip ?? '')
  expect(Number(mediaId?.[2])).toBe(t.samples)
  const peaks = await page.evaluate(
    async (id) => (await fetch(`/api/v1/media/${id}/peaks`)).status,
    mediaId?.[1] ?? '',
  )
  expect(peaks).toBe(200)
  // Saved: the recovery copy is gone.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Recorder' })).toBeVisible()
  await expect(page.getByTestId('recovery-prompt')).toHaveCount(0)
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
  await page
    .getByTestId('recovery-prompt')
    .getByRole('button', { name: /^Recover/ })
    .click()
  await expect(page.getByTestId('recorder-take')).toBeVisible()
  const t = await takeInfo(page)
  expect(t.samples % 12_000).toBe(0) // whole chunks: up to the last one saved
  expect(t.samples).toBeGreaterThanOrEqual(24_000)
  expect(t.bytes).toBe(44 + 2 * t.samples)
  await expect(page.getByTestId('recovery-prompt')).toHaveCount(0)
  // The recovered take uploads and saves like a new one, and then its copy is cleared.
  await expect(page.getByTestId('take-state')).toHaveText('saved')
  await page.reload()
  await expect(page.getByText('as usr_a')).toBeVisible()
  await expect(page.getByTestId('recovery-prompt')).toHaveCount(0)
})

test('take upload: a failed draft save keeps the recovery copy; Retry saves; Discard drops it', async ({
  page,
}) => {
  await page.evaluate(() => localStorage.setItem('mockFailSave', '1'))
  await page.getByRole('button', { name: 'Record' }).click()
  await expect(page.getByText(/captured [1-9]\.\d s/)).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByTestId('take-state')).toHaveText('failed')
  await expect(page.getByText("The draft couldn't be saved. Try again.")).toBeVisible()
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('take-state')).toHaveText('saved')
  await expect(page.getByTestId('saved-clip')).toHaveCount(1)

  // Fails again and the page goes away: the take is offered, uploaded but unsaved.
  await page.evaluate(() => localStorage.setItem('mockFailSave', '1'))
  await page.getByRole('button', { name: 'Record' }).click()
  await expect(page.getByText(/captured [1-9]\.\d s/)).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByTestId('take-state')).toHaveText('failed')
  await page.reload()
  const prompt = page.getByTestId('recovery-prompt')
  await expect(prompt).toContainText("uploaded, but the draft wasn't saved")
  await prompt.getByRole('button', { name: /^Discard/ }).click()
  await expect(prompt).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Recorder' })).toBeVisible()
  await expect(page.getByTestId('recovery-prompt')).toHaveCount(0)
})
