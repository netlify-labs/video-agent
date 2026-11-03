// The narration lock and stale-base banners in the editor (plan 2026-11-02 §2.7), on the mock build: while Ada holds
// the lock the Narration track is read-only, and Take over hands it over; Keep mine on a stale base makes the render
// dialog say whose narration it replaces.
import { expect, test } from '@playwright/test'
import { dropOnLane, toneWav } from './narration-helpers.js'

test('someone else holds the narration: read-only until you take over', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockNarrationHolder', 'ada'))
  await page.goto('/videos/vid_teaser/edit/2')
  const banner = page.getByTestId('narration-lock-banner')
  await expect(banner).toContainText(/Ada Okafor is editing the narration \(since \d\d:\d\d\)\./)
  const section = page.getByTestId('narration-section')
  await expect(section.getByTestId('narration-upload')).toBeDisabled()
  await expect(section.getByRole('switch', { name: 'Mute all original audio' })).toBeDisabled()
  await page.getByRole('button', { name: 'Take over' }).click()
  await expect(banner).toHaveCount(0)
  await expect(section.getByTestId('narration-upload')).toBeEnabled()
  await expect(section.getByRole('switch', { name: 'Mute all original audio' })).toBeEnabled()
})

test('stale base: Keep mine, and the render dialog warns', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockNarrationChanged', '1'))
  await page.goto('/videos/vid_teaser/edit/2')
  const stale = page.getByTestId('narration-stale-banner')
  await expect(stale).toContainText('Narration changed in v3 (Ada Okafor, 10 min ago)')
  await page.getByRole('button', { name: 'Keep mine' }).click()
  await expect(stale).toHaveCount(0)
  await dropOnLane(page, 'my-voice.wav', toneWav(2))
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  await page.getByRole('button', { name: /^Render as v\d+$/ }).click()
  await expect(page.getByTestId('render-warning')).toHaveText(
    'Rendering this draft replaces the narration Ada Okafor put in v3.',
  )
})
