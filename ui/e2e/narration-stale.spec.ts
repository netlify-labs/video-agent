// The stale-base banner on the mock build's demo page (/dev/narration), plan 2026-11-02 §2.7:
// localStorage.mockNarrationChanged has Ada change the narration in a newer version.
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockNarrationChanged', '1'))
  await page.goto('/dev/narration')
})

test('stale base: rebase moves the draft onto the newer version', async ({ page }) => {
  const banner = page.getByTestId('narration-stale-banner')
  await expect(banner).toContainText('Narration changed in v3 (Ada Okafor, 10 min ago)')
  await page.getByRole('button', { name: 'Rebase onto v3' }).click()
  await expect(banner).toHaveCount(0)
  await expect(page.getByTestId('narration-lock-status')).toContainText('draft on v3')
})

test('stale base: keep mine dismisses it and the render dialog warns', async ({ page }) => {
  await page.getByRole('button', { name: 'Keep mine' }).click()
  await expect(page.getByTestId('narration-stale-banner')).toHaveCount(0)
  await expect(page.getByTestId('render-warning')).toHaveText(
    'Rendering this draft replaces the narration Ada Okafor put in v3.',
  )
})
