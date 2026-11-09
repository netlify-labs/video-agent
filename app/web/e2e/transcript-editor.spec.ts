// Correcting narration captions without a render (plan 2026-11-02 §2.6), on the mock build: the Video page lists the
// cues with their timings, a corrected word saves as the next revision, and the player's captions track follows it.
import { expect, test } from '@playwright/test'

test('edit a cue: the fix saves as a revision and the player loads it', async ({ page }) => {
  await page.goto('/videos/vid_sales')
  const editor = page.getByTestId('transcript-editor')
  await expect(editor.getByText('0:03.6 – 0:07.8')).toBeVisible()
  const cue = editor.getByLabel('Caption at 0:03.6')
  await expect(cue).toHaveValue('Review the real site, not a screen shot.')
  const save = editor.getByRole('button', { name: 'Save fixes' })
  await expect(save).toBeDisabled()
  await cue.fill('Review the real site, not a screenshot.')
  await save.click()
  await expect(editor.getByText('Corrected (1)')).toBeVisible()
  await expect(editor.getByLabel('Caption at 0:03.6')).toHaveValue('Review the real site, not a screenshot.')
  await expect(save).toBeDisabled()
  // The player's track is now the revision's, and it has the fix.
  const track = page.locator('video track[kind="captions"]')
  await expect(track).toHaveAttribute('src', '/api/v1/videos/vid_sales/versions/1/captions?rev=1')
  const vtt = await page.evaluate(async () =>
    (await fetch('/api/v1/videos/vid_sales/versions/1/captions?rev=1')).text(),
  )
  expect(vtt).toContain('Review the real site, not a screenshot.')
})

test('a version without narration captions has no transcript editor', async ({ page }) => {
  await page.goto('/videos/vid_docs')
  await expect(page.getByText('Details for v1')).toBeVisible()
  await expect(page.getByTestId('transcript-editor')).toHaveCount(0)
})
