// Reviewing a take before it goes on the timeline (owner, 2026-11-06; record flow, Review) on the mock build: a
// stopped take waits in the Record a take panel with play/pause and a scrubber against the picture, its length and
// where it lands; nothing is on the track until Add. Discard (Esc) drops it, Record again records it again, and a take
// that stopped early offers Keep recording from here, which punches in from where it stopped and reviews the joined
// take. The mic is the stand-in (window.__vaTestMic, as in record-flow.spec.ts).
import { expect, test, type Page } from '@playwright/test'

const RATE = 24_000

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
  mediaId: string
  start: number
  srcStart: number
  srcEnd: number
}
const savedClips = (page: Page) =>
  page.evaluate(() => {
    const ops = (globalThis as unknown as { __lastEditOps?: { op: string; clips?: unknown[] }[] })
      .__lastEditOps
    return ops?.find((o) => o.op === 'narration')?.clips ?? []
  }) as Promise<Clip[]>
const phase = (page: Page) => page.getByTestId('record-status')
const seconds = (text: string | null) => {
  const m = /(\d+):(\d+(?:\.\d+)?)/.exec(text ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

async function recordAndStop(page: Page, ms = 2_500) {
  await page.getByTestId('record-start').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  await page.waitForTimeout(ms)
  await page.keyboard.press('Space')
  await expect(phase(page)).toHaveAttribute('data-phase', 'review', { timeout: 30_000 })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: TEST_MIC })
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('narration-section')).toBeVisible()
  await page.getByTestId('record-open').click()
  await expect(page.getByTestId('record-panel')).toBeVisible()
})

test('a stopped take waits in review: its length and where it lands, play and scrub with the picture; Esc discards it', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await recordAndStop(page)
  const review = page.getByTestId('take-review')
  await expect(review).toBeVisible()
  await expect(page.locator('.va-tl-clip')).toHaveCount(0)
  await expect(page.getByTestId('review-summary')).toContainText(/The take is \d+\.\d s long and lands at/)
  const lands = await page.getByTestId('review-lands').textContent()
  expect(seconds(lands?.split(' to ')[0] ?? '')).toBeLessThan(0.1)
  expect(seconds(lands?.split(' to ')[1] ?? '')).toBeGreaterThan(1.5)
  // Play: the picture and the review time move together; pause stops them.
  await page.getByTestId('review-play').click()
  await expect
    .poll(async () => seconds(await page.getByTestId('review-time').textContent()))
    .toBeGreaterThan(0.3)
  await expect
    .poll(() =>
      page.getByTestId('record-picture').evaluate((v) => (v as unknown as { paused: boolean }).paused),
    )
    .toBe(false)
  await page.getByTestId('review-play').click()
  await expect
    .poll(() =>
      page.getByTestId('record-picture').evaluate((v) => (v as unknown as { paused: boolean }).paused),
    )
    .toBe(true)
  // The scrubber moves the picture.
  const before = await page
    .getByTestId('record-picture')
    .evaluate((v) => (v as unknown as { currentTime: number }).currentTime)
  await page.getByRole('slider', { name: 'Review position' }).focus()
  await page.keyboard.press('End')
  await expect
    .poll(() =>
      page
        .getByTestId('record-picture')
        .evaluate((v) => (v as unknown as { currentTime: number }).currentTime),
    )
    .toBeGreaterThan(before + 0.5)
  // Esc discards (the slider keeps its own keys, so blur it first).
  await page.locator('body').click({ position: { x: 2, y: 2 } })
  await page.keyboard.press('Escape')
  await expect(phase(page)).toHaveAttribute('data-phase', 'setup')
  await expect(page.getByTestId('record-notice')).toHaveText('Take discarded.')
  await page.waitForTimeout(1_500)
  await expect(page.locator('.va-tl-clip')).toHaveCount(0)
  expect(await savedClips(page)).toEqual([])
})

test('Record again drops the take and records a new one, which Add puts on the track', async ({ page }) => {
  test.setTimeout(120_000)
  await recordAndStop(page)
  const first = await page.getByTestId('take-review').getAttribute('data-recording')
  // Once the take has uploaded (one uploads at a time).
  await expect(page.getByTestId('review-again')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('review-again').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  await page.waitForTimeout(2_000)
  await page.keyboard.press('Space')
  await expect(phase(page)).toHaveAttribute('data-phase', 'review', { timeout: 30_000 })
  expect(await page.getByTestId('take-review').getAttribute('data-recording')).not.toBe(first)
  await page.getByTestId('review-add').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'saved', { timeout: 30_000 })
  await expect.poll(async () => (await savedClips(page)).length).toBe(1)
})

test('a take that stopped early offers Keep recording from here: it punches in from the stop and the joined take is added', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.getByTestId('record-start').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  await page.waitForTimeout(2_000)
  // Hiding the tab stops it early (a string: the specs aren't typechecked against the DOM library).
  await page.evaluate(
    "Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'))",
  )
  await expect(phase(page)).toHaveAttribute('data-phase', 'review', { timeout: 30_000 })
  await expect(page.getByTestId('review-stop')).toContainText('Keep this tab in front')
  const end = seconds(((await page.getByTestId('review-lands').textContent()) ?? '').split(' to ')[1] ?? '')
  await page.evaluate(
    "Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange'))",
  )
  const go = page.getByTestId('review-continue')
  await expect(go).toBeEnabled({ timeout: 30_000 })
  await expect(go).toContainText('Keep recording from')
  await go.click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  await page.waitForTimeout(2_000)
  await page.keyboard.press('Space')
  await expect(phase(page)).toHaveAttribute('data-phase', 'review', { timeout: 30_000 })
  await expect(page.getByTestId('review-summary')).toContainText('The joined take')
  await page.keyboard.press('Enter')
  await expect(phase(page)).toHaveAttribute('data-phase', 'saved', { timeout: 30_000 })
  // The first take, then the continuation from where it stopped.
  await expect.poll(async () => (await savedClips(page)).length).toBeGreaterThanOrEqual(2)
  const clips = (await savedClips(page)).sort((a, b) => a.start - b.start)
  const next = clips.find((c) => c.start > RATE)
  expect(next).toBeDefined()
  expect(Math.abs((next?.start ?? 0) / RATE - end)).toBeLessThan(0.2)
})

test('with real-ish frame jitter (vsync lateness, a frame step, a 250 ms block), a take runs until Space and never stops on its own', async ({
  page,
}) => {
  test.setTimeout(120_000)
  // Frames as uneven as a real 60 Hz screen's (picture.ts reads window.__vaTestFrameJitter): every third a vsync late,
  // ±6 ms of jitter, from 60 frames in one frame behind (a step), and from 120 a 250 ms main-thread block's lag.
  await page.addInitScript(() => {
    let n = 0
    ;(
      globalThis as unknown as { __vaTestFrameJitter?: (m: Record<string, number>) => Record<string, number> }
    ).__vaTestFrameJitter = (m) => {
      n++
      const late = (n % 3 === 0 ? 16.7 : 0) + (Math.random() * 12 - 6) + (n > 120 ? 250 : 0)
      return {
        ...m,
        expectedDisplayTime: (m.expectedDisplayTime ?? 0) + late,
        mediaTime: (m.mediaTime ?? 0) - (n > 60 ? 1 / 30 : 0),
      }
    }
  })
  await page.reload()
  await page.getByTestId('record-open').click()
  await page.getByTestId('record-start').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  await page.waitForTimeout(6_000)
  // Still recording: nothing stopped it.
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording')
  await page.keyboard.press('Space')
  await expect(phase(page)).toHaveAttribute('data-phase', 'review', { timeout: 30_000 })
  await expect(page.getByTestId('review-stop')).toHaveCount(0)
  const lands = (await page.getByTestId('review-lands').textContent()) ?? ''
  expect(seconds(lands.split(' to ')[1] ?? '')).toBeGreaterThan(5)
})

test('Record resets the prompter to the take’s first line during the countdown, not where the last take ended', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const prompter = page.getByTestId('teleprompter')
  const first = await prompter.locator('[data-state]').first().textContent()
  // A first take that runs past the first scene (the prompter moves on), added to the track.
  await page.getByTestId('record-start').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  await expect(prompter.locator('[data-state=current]')).not.toHaveText(first ?? '', { timeout: 15_000 })
  await page.keyboard.press('Space')
  await expect(phase(page)).toHaveAttribute('data-phase', 'review', { timeout: 30_000 })
  // Leave the picture at the take's end (as playing the review through does), then add it.
  await page.getByRole('slider', { name: 'Review position' }).focus()
  await page.keyboard.press('End')
  await expect(prompter.locator('[data-state=current]')).not.toHaveText(first ?? '')
  await page.getByTestId('review-add').click()
  await expect(phase(page)).toHaveAttribute('data-phase', 'saved', { timeout: 30_000 })
  // Record: at once (before the new take has even cued the picture) and through the 3-2-1, the first line.
  await page.getByTestId('record-start').click()
  expect(await prompter.locator('[data-state=current]').textContent()).toBe(first)
  await expect(page.getByTestId('record-countdown')).toBeVisible()
  await expect(prompter.locator('[data-state=current]')).toHaveText(first ?? '')
  await page.keyboard.press('Escape')
})
