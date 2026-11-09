// Downloading a take's audio (owner, 2026-11-06) on the mock build: from the take review row before it's added, and
// from a selected narration clip after, named after the video, the version and the take. A recorded take is a WAV;
// where the browser can encode AAC there's also a smaller M4A.
import { expect, test, type Page } from '@playwright/test'

const TEST_MIC = `
window.__vaTestMicDevices = () => [{ deviceId: 'mic-usb', label: 'USB Studio Mic' }]
window.__vaTestMic = (ctx) => {
  const osc = ctx.createOscillator()
  osc.frequency.value = 440
  const gate = ctx.createGain()
  const t = ctx.currentTime
  for (let i = 0; i < 240; i++) gate.gain.setValueAtTime(i % 2 === 0 ? 0.3 : 0, t + i)
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  osc.connect(gate).connect(dest)
  osc.start()
  return dest.stream
}`
const phase = (page: Page) => page.getByTestId('record-status')

/** Clicks a Download (a menu when a smaller copy is offered) and returns the saved file's name and size. */
async function download(page: Page, testId: string, kind: 'file' | 'small' = 'file') {
  const wait = page.waitForEvent('download')
  await page.getByTestId(testId).click()
  const item = page.getByTestId(kind === 'file' ? 'take-download-file' : 'take-download-small')
  if (await item.isVisible().catch(() => false)) await item.click()
  const d = await wait
  const path = await d.path()
  const { statSync } = await import('node:fs')
  return { name: d.suggestedFilename(), bytes: path ? statSync(path).size : 0 }
}

test('a take downloads from review and, once added, from its clip, named after the video and the take', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.addInitScript({ content: TEST_MIC })
  await page.goto('/videos/vid_teaser/edit/2')
  await page.getByTestId('record-open').click()
  await page.getByTestId('record-start').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  await page.waitForTimeout(2_000)
  await page.keyboard.press('Space')
  await expect(phase(page)).toHaveAttribute('data-phase', 'review', { timeout: 30_000 })

  const fromReview = await download(page, 'review-download')
  expect(fromReview.name).toBe('ship-faster-with-preview-deploys-v2-take-1.wav')
  // A 24 kHz 16-bit mono WAV of about 2 s: at least 48 KB of samples after its header.
  expect(fromReview.bytes).toBeGreaterThan(48_000)

  await page.getByTestId('review-add').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'saved', { timeout: 30_000 })
  await page.locator('.va-tl-clip[data-clip-id="nar_1"]').click()
  await expect(page.getByTestId('clip-download')).toBeEnabled({ timeout: 15_000 })
  const fromClip = await download(page, 'clip-download')
  expect(fromClip.name).toBe('ship-faster-with-preview-deploys-v2-take-1.wav')
  // The mock API serves a stand-in file for uploaded media (the real one serves the take as uploaded).
  expect(fromClip.bytes).toBeGreaterThan(0)
})

test('where the browser encodes AAC, the smaller M4A downloads too', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript({ content: TEST_MIC })
  await page.goto('/videos/vid_teaser/edit/2')
  const aac = await page.evaluate(async () => {
    const E = (
      globalThis as unknown as {
        AudioEncoder?: { isConfigSupported: (c: object) => Promise<{ supported: boolean }> }
      }
    ).AudioEncoder
    if (!E) return false
    return (
      await E.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 24_000,
        numberOfChannels: 1,
        bitrate: 96_000,
      })
    ).supported
  })
  test.skip(!aac, "This browser can't encode AAC (the menu offers only the WAV).")
  await page.getByTestId('record-open').click()
  await page.getByTestId('record-start').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  await page.waitForTimeout(2_000)
  await page.keyboard.press('Space')
  await expect(phase(page)).toHaveAttribute('data-phase', 'review', { timeout: 30_000 })
  const wav = await download(page, 'review-download', 'file')
  const small = await download(page, 'review-download', 'small')
  expect(small.name).toBe('ship-faster-with-preview-deploys-v2-take-1.m4a')
  expect(small.bytes).toBeGreaterThan(1_000)
  expect(small.bytes).toBeLessThan(wav.bytes / 3)
})
