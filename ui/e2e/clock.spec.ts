// The recorder's picture clock on the mock build's demo page (/dev/clock): rVFC anchors on a real muted MP4, the fit,
// and the stop rules a real browser fires (hidden tab, seek).
import { expect, test, type Page } from '@playwright/test'

async function startTake(page: Page) {
  await page.goto('/dev/clock')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByTestId('clock-state')).toHaveText('running')
  // About a second of frames.
  await expect.poll(async () => Number(await page.getByTestId('clock-anchors').textContent()), { timeout: 10_000 }).toBeGreaterThan(25)
}

test('clock: anchors from the muted picture fit as one clean segment, with a placement', async ({ page }) => {
  await startTake(page)
  await expect(page.getByTestId('clock-offset')).toHaveText(/ms$/)
  await expect(page.getByTestId('clock-fit')).not.toHaveAttribute('data-segments', '0')
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByTestId('clock-stop')).toHaveAttribute('data-kind', 'user')
  const fit = JSON.parse((await page.getByTestId('clock-fit').textContent()) ?? '{}') as {
    cleanSamples: number
    segments: { from: number; to: number; maxMs: number }[]
    placement: { start: number; srcStart: number; srcEnd: number; offsetSamples: number }[]
  }
  expect(fit.cleanSamples).toBeGreaterThan(24_000)
  expect(fit.segments.length).toBeGreaterThanOrEqual(1)
  expect(fit.segments.at(-1)?.to).toBe(fit.cleanSamples)
  expect(fit.placement[0]?.srcStart).toBe(0)
  expect(fit.placement.at(-1)?.srcEnd).toBe(fit.cleanSamples)
})

test('clock: hiding the tab stops the take with its reason', async ({ page }) => {
  await startTake(page)
  // A string, because the specs aren't typechecked against the DOM library.
  await page.evaluate(
    "Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange'))",
  )
  await expect(page.getByTestId('clock-stop')).toHaveAttribute('data-kind', 'hidden')
  await expect(page.getByTestId('clock-stop')).toContainText('Keep this tab in front')
  await expect(page.getByTestId('clock-state')).toHaveText('stopped')
  const fit = JSON.parse((await page.getByTestId('clock-fit').textContent()) ?? '{}') as { cleanSamples: number }
  expect(fit.cleanSamples).toBeGreaterThan(0)
})

test('clock: seeking the picture stops the take', async ({ page }) => {
  await startTake(page)
  await page.getByTestId('clock-video').evaluate((v) => {
    ;(v as unknown as { currentTime: number }).currentTime = 5
  })
  await expect(page.getByTestId('clock-stop')).toHaveAttribute('data-kind', 'seek')
})
