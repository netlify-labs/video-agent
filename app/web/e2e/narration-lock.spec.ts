// The narration soft lock on the mock build's demo page (/dev/narration), plan 2026-11-02 §2.7. The mock server is
// in-page, so a second person is simulated: localStorage.mockNarrationHolder starts with Ada holding the lock, and
// window.__mockNarrationTakeOver has her take it over while you hold it.
import { expect, test, type Page } from '@playwright/test'

const banner = (page: Page) => page.getByTestId('narration-lock-banner')

test('narration lock: someone else holds it, you take over, Record turns on', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockNarrationHolder', 'ada'))
  await page.goto('/dev/narration')
  await expect(banner(page)).toContainText(/Ada Okafor is editing the narration \(since \d\d:\d\d\)\./)
  await expect(page.getByRole('button', { name: 'Record' })).toBeDisabled()
  await page.getByRole('button', { name: 'Watch' }).click()
  await expect(page.getByTestId('narration-lock-status')).toContainText('watching')
  await page.getByRole('button', { name: 'Take over' }).click()
  await expect(banner(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Record' })).toBeEnabled()
  await expect(page.getByTestId('narration-lock-status')).toContainText('held')
})

test('narration lock: when someone takes it over, the next heartbeat says so and save turns off', async ({
  page,
}) => {
  await page.clock.install()
  await page.goto('/dev/narration')
  await expect(page.getByTestId('narration-lock-status')).toContainText('held')
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  await page.evaluate(() =>
    (globalThis as unknown as { __mockNarrationTakeOver: (k: string) => void }).__mockNarrationTakeOver(
      'ada',
    ),
  )
  await page.clock.runFor(31_000)
  await expect(banner(page)).toHaveText(
    /Ada Okafor took over the narration\. Your draft is saved; you can render it or discard it\./,
  )
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  await page.getByRole('button', { name: 'Take it back' }).click()
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
})
