// Publishing a version with recorded narration (plan 2026-11-02 §6.7), on the mock build: the publish dialog asks
// whether the share page shows the transcript, with a preview, off by default; the choice is sent with the publish
// and remembered for the next one. A version without narration publishes in one click, as before.
import { expect, test, type Page } from '@playwright/test'

const lastPublish = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __lastPublish?: unknown }).__lastPublish)

test('the transcript is off by default, previewed, sent with the publish and remembered', async ({
  page,
}) => {
  await page.goto('/videos/vid_sales')
  await page.getByRole('button', { name: 'Publish v1' }).click()
  const dialog = page.getByRole('dialog', { name: 'Publish v1' })
  const toggle = dialog.getByRole('switch', { name: 'Show transcript on the share page' })
  await expect(toggle).not.toBeChecked()
  const preview = dialog.getByLabel('Transcript preview')
  await expect(preview).toContainText('Not shown. Preview:')
  await expect(preview).toContainText('Every pull request gets its own URL.')
  await expect(preview).toContainText('Merge with confidence. Book a demo.')
  await toggle.click()
  await expect(preview).toContainText('The share page will show:')
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(() => lastPublish(page)).toEqual({ showTranscript: true })
  await expect(page.getByText('Public link for v1')).toBeVisible()
  await expect(page.getByText('Transcript', { exact: true })).toBeVisible()

  // A fresh page (the mock forgets the publication) opens with the choice remembered.
  await page.reload()
  await page.getByRole('button', { name: 'Publish v1' }).click()
  const again = page.getByRole('dialog', { name: 'Publish v1' })
  await expect(again.getByRole('switch', { name: 'Show transcript on the share page' })).toBeChecked()
  await again.getByRole('switch', { name: 'Show transcript on the share page' }).click()
  await again.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect.poll(() => lastPublish(page)).toEqual({ showTranscript: false })
})

test('a version without recorded narration publishes in one click', async ({ page }) => {
  await page.goto('/videos/vid_docs')
  await page.getByRole('button', { name: 'Publish v1' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('Public link for v1')).toBeVisible()
})
