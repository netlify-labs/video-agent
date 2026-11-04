// How a version was made (VersionDetails.tsx): the Details card shows the request and a few facts; its info button,
// its link and each version row's info button open a modal with everything the run was given; Esc closes it.
import { expect, test } from '@playwright/test'

test('the Details card opens everything a version was made with, and Esc closes it', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  const card = page.getByTestId('details-card')
  await expect(card).toContainText('Details for v2')
  await expect(card).toContainText('Keep everything, but make the end card text')
  await expect(card).toContainText('Feedback on v1 incorporated')

  await card.getByRole('button', { name: 'How v2 was made' }).click()
  const modal = page.getByTestId('version-details')
  await expect(page.getByRole('dialog', { name: 'How v2 was made' })).toBeVisible()
  await expect(modal).toContainText('Keep everything, but make the end card text "Start free today".')
  // The feedback it was asked to incorporate, as it was sent.
  await expect(modal).toContainText('Feedback it was asked to incorporate (1)')
  await expect(modal).toContainText('Ada Okafor')
  await expect(modal).toContainText('The end card should say "Start free today".')
  await expect(modal).toContainText('16:9 · 1920×1080')
  await expect(modal).toContainText('claude-opus-5-5')
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)

  // The link under the prompt opens it too.
  await card.getByRole('button', { name: 'Everything it was made with' }).click()
  await expect(modal).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
})

test("a version row's info button opens that version's details, plan included", async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.locator('.va-version-info').getByRole('button', { name: 'How v1 was made' }).click()
  const modal = page.getByTestId('version-details')
  await expect(page.getByRole('dialog', { name: 'How v1 was made' })).toBeVisible()
  await expect(modal).toContainText('The first version')
  await expect(modal).toContainText('A short product teaser: the words "Ship faster" appear')
  await expect(modal).toContainText('The plan')
  await expect(modal).toContainText('Developers who ship web apps')
  await expect(modal).toContainText('End card: "Try it today"')
  await expect(modal).toContainText('Who is it for?')
  // Opening it doesn't select the version: v2 is still the one shown.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('details-card')).toContainText('Details for v2')
})
