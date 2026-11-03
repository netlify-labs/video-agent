// Recording a take in the editor (plan 2026-11-02 §2.1, §5.1, §5.3) on the mock build: Record voice-over opens the
// setup and the picture with the teleprompter; Record counts 3-2-1 with the mic already capturing, plays the muted MP4
// and records against its frames; Space keeps the take, which uploads and lands on the Narration lane at composition
// 0 (the countdown trimmed off) and is saved with the draft. Esc discards; hiding the tab stops and keeps the part; a
// reload mid-take offers the take again; someone else's lock and pending timing changes keep Record away. The mic is
// the stand-in (window.__vaTestMic, see recorder.spec.ts for why).
import { expect, test, type Page } from '@playwright/test'

const RATE = 24_000

/** The stand-in mic: a 440 Hz tone gated one second on, one off (page script). */
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

interface Clip {
  id: string
  mediaId: string
  start: number
  srcStart: number
  srcEnd: number
  offsetSamples: number
  fit: { a: number; b: number; residualMs: number }
}

/** The narration clips the last draft save sent. */
const savedClips = (page: Page) =>
  page.evaluate(() => {
    const ops = (globalThis as unknown as { __lastEditOps?: { op: string; clips?: unknown[] }[] })
      .__lastEditOps
    return ops?.find((o) => o.op === 'narration')?.clips ?? []
  }) as Promise<Clip[]>

async function openEditor(page: Page) {
  await page.addInitScript({ content: TEST_MIC })
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('narration-section')).toBeVisible()
}

async function openRecorder(page: Page) {
  await page.getByTestId('record-open').click()
  await expect(page.getByTestId('record-panel')).toBeVisible()
  await expect(page.getByTestId('prompter-layout')).toBeVisible()
  // The picture is the base version's MP4, muted, in this document.
  await expect(page.getByTestId('record-picture')).toHaveJSProperty('muted', true)
}

/** Record, through the countdown, until the picture plays. */
async function startTake(page: Page) {
  await page.getByTestId('record-start').click()
  await expect(page.getByTestId('record-countdown')).toHaveText('3')
  await expect(page.getByTestId('record-status')).toHaveAttribute('data-phase', 'recording', {
    timeout: 20_000,
  })
}

const phase = (page: Page) => page.getByTestId('record-status')

test('record a take: setup, countdown, picture, Space keeps it, and it lands at the picture time and saves', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openEditor(page)
  await openRecorder(page)
  // The setup's level check gives its verdict on the stand-in mic.
  await page.getByRole('button', { name: 'Check mic' }).click()
  await expect(page.getByTestId('mic-meter')).toBeVisible()
  await page.getByRole('button', { name: 'Check level' }).click()
  await expect(page.getByTestId('level-verdict')).toBeVisible({ timeout: 10_000 })
  // A new route prompts for calibration.
  await expect(page.getByTestId('record-panel')).toContainText(/calibrat/i)

  await startTake(page)
  await page.waitForTimeout(3_000)
  await page.keyboard.press('Space')
  await expect(phase(page)).toHaveAttribute('data-phase', 'saved', { timeout: 30_000 })
  await expect(page.getByTestId('record-notice')).toHaveCount(0)

  const clip = page.locator('.va-tl-clip[data-clip-id="nar_1"]')
  await expect(clip).toBeVisible()
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  const clips = await savedClips(page)
  expect(clips).toHaveLength(1)
  const c = clips[0]
  if (!c) throw new Error('no clip saved')
  expect(c.mediaId).toMatch(/^med_/)
  // The take starts where the picture started: composition 0, with the countdown's 3 s (give or take the picture's
  // start-up and its first frame) trimmed off the front, and about the 3 s recorded against the picture after it.
  expect(c.start).toBeGreaterThanOrEqual(0)
  expect(c.start).toBeLessThanOrEqual(RATE / 30)
  expect(c.srcStart).toBeGreaterThan(2.5 * RATE)
  expect(c.srcStart).toBeLessThan(8 * RATE)
  expect((c.srcEnd - c.srcStart) / RATE).toBeGreaterThan(2)
  expect((c.srcEnd - c.srcStart) / RATE).toBeLessThan(5)
  // The whole fit is kept, its slope one second per second.
  expect(Math.abs(c.fit.b * RATE - 1)).toBeLessThan(0.01)
})

test('Esc discards the take: nothing uploads and Record is back', async ({ page }) => {
  test.setTimeout(60_000)
  await openEditor(page)
  await openRecorder(page)
  await startTake(page)
  await page.waitForTimeout(1_000)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('record-notice')).toHaveText('Take discarded.')
  await expect(phase(page)).toHaveAttribute('data-phase', 'setup')
  await expect(page.getByTestId('record-start')).toBeEnabled()
  await expect(page.locator('.va-tl-clip')).toHaveCount(0)
  expect(await savedClips(page)).toEqual([])
})

test('hiding the tab stops the take, says why, and keeps the part before it', async ({ page }) => {
  test.setTimeout(90_000)
  await openEditor(page)
  await openRecorder(page)
  await startTake(page)
  await page.waitForTimeout(2_000)
  // A string, because the specs aren't typechecked against the DOM library.
  await page.evaluate(
    "Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'))",
  )
  const notice = page.getByTestId('record-notice')
  await expect(notice).toHaveAttribute('data-kind', 'hidden')
  await expect(notice).toContainText('Keep this tab in front')
  await expect(phase(page)).toHaveAttribute('data-phase', 'saved', { timeout: 30_000 })
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible()
  const [c] = await savedClips(page)
  expect(c && (c.srcEnd - c.srcStart) / RATE).toBeGreaterThan(1)
})

test('a reload mid-take offers the take again, and recovering it puts it where it was recorded', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openEditor(page)
  await openRecorder(page)
  await startTake(page)
  // Past the first placement checkpoint.
  await page.waitForTimeout(3_000)
  await page.reload()
  const prompt = page.getByTestId('recovery-prompt')
  await expect(prompt).toContainText('recording was interrupted')
  await prompt.getByRole('button', { name: /^Recover/ }).click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'saved', { timeout: 30_000 })
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible()
  await expect(prompt).toHaveCount(0)
  const [c] = await savedClips(page)
  expect(c?.start).toBeLessThanOrEqual(RATE / 30)
  expect(c?.srcStart).toBeGreaterThan(2.5 * RATE)
})

test('someone else holds the narration lock: Record is off', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockNarrationHolder', 'ada'))
  await openEditor(page)
  await expect(page.getByTestId('record-open')).toBeDisabled()
  await expect(page.getByTestId('narration-recorder')).toContainText('Recording needs the narration lock.')
  await page.getByRole('button', { name: 'Take over' }).click()
  await expect(page.getByTestId('record-open')).toBeEnabled()
})

test('timing changes pending: Render picture first takes the place of Record', async ({ page }) => {
  await openEditor(page)
  await expect(page.getByTestId('record-open')).toBeVisible()
  await page.getByRole('textbox', { name: 'Length of Opening' }).fill('4.5')
  await expect(page.getByTestId('render-picture-first')).toBeVisible()
  await expect(page.getByTestId('record-open')).toHaveCount(0)
})
