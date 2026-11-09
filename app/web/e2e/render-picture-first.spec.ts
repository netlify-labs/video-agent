// Render picture first (plan 2026-11-02 §2.1, §5.3) on the mock build: a retime pending under a narration clip puts
// "Render picture first" where Record goes; one click renders the draft without its narration as v3, its progress
// shows in place, and the editor reopens on v3 with the narration carried over and nothing blocking the recording.
import { expect, test } from '@playwright/test'
import { dropOnLane, toneWav } from './narration-helpers.js'

test('timing edits pending: Render picture first renders v3 and reopens Narration there with the take', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('narration-section')).toBeVisible()
  await dropOnLane(page, 'my-voice.wav', toneWav(2))
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  // Narration and audio alone don't move time: nothing blocks recording.
  const cta = page.getByTestId('render-picture-first')
  await expect(cta).toHaveCount(0)

  // A retime does: Record's place says why and offers the render, once the draft has saved.
  await page.getByRole('textbox', { name: 'Length of Opening' }).fill('4.5')
  await expect(cta).toContainText("Your timing changes aren't in the picture yet")
  const button = page.getByRole('button', { name: 'Render picture first (about 34 credits)' })
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  await expect(button).toBeEnabled()
  await button.click()
  await expect
    .poll(() => page.evaluate<unknown>('window.__lastRender ?? null'))
    .toEqual({ mode: 'keep_visuals', excludeNarration: true })

  // Its progress shows in place, then the editor reopens on v3 with the narration on its draft.
  await expect(cta).toContainText('Rendering the picture as v3')
  await expect(page.getByTestId('render-picture-first-stage')).toBeVisible()
  await expect(page).toHaveURL(/\/videos\/vid_teaser\/edit\/3$/, { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Edit v3' })).toBeVisible()
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('render-picture-first')).toHaveCount(0)
  await expect(page.getByTestId('resume-draft')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Length of Opening' })).toHaveValue('3 s')
})
