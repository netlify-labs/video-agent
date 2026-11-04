// Attaching files (AttachFiles.tsx): dropping files on the comment box or the revision box uploads them to the
// library and attaches them; a comment shows its files; the revision sends them as media.
import { expect, test, type Page } from '@playwright/test'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** Drops a small PNG on the box with this label, as a file dragged from the desktop would. */
const dropOn = (page: Page, label: string, name: string) =>
  page.evaluate(`(() => {
    const box = document.querySelector('textarea[aria-label="${label}"]')?.closest('.va-drop-target')
    if (!box) throw new Error('no drop target for ${label}')
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob('${PNG}'), (c) => c.charCodeAt(0))], '${name}', { type: 'image/png' }))
    for (const type of ['dragover', 'drop'])
      box.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  })()`)

test('a file dropped on the comment box is attached, posted with the comment and shown on it', async ({
  page,
}) => {
  await page.goto('/videos/vid_teaser')
  await expect(page.getByRole('textbox', { name: 'Add a comment' })).toBeVisible()
  await dropOn(page, 'Add a comment', 'shot.png')
  await expect(page.getByTestId('chip-med_mock0001')).toContainText('shot.png')
  await page.getByRole('textbox', { name: 'Add a comment' }).fill('Use this on the end card')
  await page.getByRole('button', { name: 'Comment', exact: true }).click()
  const sent = () =>
    page.evaluate(
      () => (globalThis as unknown as { __lastComment?: { mediaIds?: string[] } }).__lastComment ?? null,
    )
  await expect.poll(sent).toMatchObject({ body: 'Use this on the end card', mediaIds: ['med_mock0001'] })
  const first = page.getByTestId('comment').first()
  await expect(first.getByTestId('comment-files')).toContainText('shot.png')
  // The box is clear for the next comment.
  await expect(page.getByTestId('chip-med_mock0001')).toHaveCount(0)
})

test('a file dropped on the revision box is attached and sent with the revision', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible()
  await dropOn(page, 'What should change?', 'logo.png')
  await expect(page.getByTestId('chip-med_mock0001')).toContainText('logo.png')
  await page.getByRole('textbox', { name: 'What should change?' }).fill('Put this logo on the end card')
  await page.getByRole('button', { name: /^Make v3/ }).click()
  const sent = () =>
    page.evaluate(
      () => (globalThis as unknown as { __lastRevise?: { mediaIds?: string[] } }).__lastRevise ?? null,
    )
  await expect.poll(sent).toMatchObject({ mediaIds: ['med_mock0001'] })
})
