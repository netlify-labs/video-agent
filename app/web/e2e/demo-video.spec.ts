// A demo on the video page (screen-recording plan §8.1; va-rsk5.4.3, the phase 3 gate) on the mock build (mockDemo,
// vid_sales: an unpublished v1 with narration, so the Publish dialog opens either way):
// "Made from a recording" with its summary, the Hidden list with why each area is hidden, the Publish dialog's line
// about what Video Agent hid until it's checked, and Looks right, which sends the unchecked ids and clears that line.
// Privacy mode's warnings (what the check of the finished video could still read) show in both, and stay.
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: "localStorage.setItem('mockDemo', 'vid_sales')" })
  await page.goto('/videos/vid_sales')
})

test('the Hidden list says why; Publish says what is unchecked until Looks right', async ({ page }) => {
  const list = page.getByTestId('hidden-list')
  await expect(list.getByTestId('recording-summary')).toHaveText(
    '1:15 recording: 3 scenes, 0:31 cut, 2 areas hidden',
  )
  await expect(list.getByTestId('hidden-entry')).toHaveText([/You drew it/, /Privacy mode: email/])
  await expect(
    list.getByText(/people who can open this video can still watch the full recording/),
  ).toBeVisible()
  await expect(list.getByTestId('privacy-warning')).toHaveText(['An email may still be readable at 0:12'])

  await page.getByRole('button', { name: /^Publish v\d/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('publish-demo-note')).toContainText(
    'Video Agent hid 1 thing it thought were private',
  )
  await expect(dialog.getByTestId('publish-privacy-warning')).toContainText('readable at 1 moment')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await list.getByRole('button', { name: 'Looks right' }).click()
  await expect(list.getByText('Checked')).toHaveCount(2)
  expect(await page.evaluate<string[][]>('window.__mockDemoConfirms ?? []')).toEqual([['s1', 'p1']])
  await expect(list.getByRole('button', { name: 'Looks right' })).toHaveCount(0)

  await page.getByRole('button', { name: /^Publish v\d/ }).click()
  await expect(page.getByRole('dialog').getByTestId('publish-demo-note')).not.toContainText('Video Agent hid')
})
