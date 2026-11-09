// The video's spoken language (plan 2026-11-02 §6.6 "Language"): set from the video page's menu, saved through the
// mock's video update, shown after. Languages the local transcriber doesn't cover say they need ElevenLabs.
import { expect, test } from '@playwright/test'

test('sets the spoken language from the video menu', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByTestId('video-language')).toContainText('Language: English')
  await page.getByTestId('video-language').click()
  const select = page.getByTestId('language-select')
  await select.fill('Japanese')
  await expect(page.getByRole('option', { name: 'Japanese (needs ElevenLabs)' })).toBeVisible()
  await select.fill('German')
  await page.getByRole('option', { name: 'German' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByTestId('video-language')).toContainText('Language: German')
})
