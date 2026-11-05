// Discard changes (Edit.tsx): off until the draft has a change; it deletes the draft and goes back to the video, and
// the editor opens clean again.
import { expect, test } from '@playwright/test'

test('discard is off with nothing to discard; after discarding, the editor opens clean', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  const discard = page.getByRole('button', { name: 'Discard changes' })
  await expect(page.getByTestId('edit-status')).toContainText('No changes yet')
  await expect(discard).toBeDisabled()

  // A change turns it on.
  await page.getByRole('textbox', { name: 'Length of Opening' }).fill('4.5')
  await expect(discard).toBeEnabled()
  await discard.click()
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click()
  await expect(page).toHaveURL(/\/videos\/vid_teaser$/)

  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('edit-status')).toContainText('No changes yet')
  await expect(page.getByTestId('resume-draft')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
})
