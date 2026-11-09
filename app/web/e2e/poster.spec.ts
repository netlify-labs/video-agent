// Picking a version's poster (app/server/domain/poster.ts), against the mock build: the frame you're on, an uploaded image
// cropped to the video's shape, and back to the default; the editor's header has the same menu.
import { expect, test, type Page } from '@playwright/test'

const posterBody = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __posterBody?: { source: string; at?: number; jpg: string; lqip?: string }
        }
      ).__posterBody,
  )

/** A 1×1 PNG: square, so the upload has to be cropped to 16:9. */
const SQUARE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/** The width and height of a base64 JPEG, read in the page. */
const jpegSize = (page: Page, b64: string) =>
  page.evaluate<number[]>(
    `createImageBitmap(new Blob([Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))])).then((b) => [b.width, b.height])`,
  )

test('video page: use the frame you are on, upload an image, reset', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  const row = page.getByTestId('video-actions')
  const button = row.getByRole('button', { name: 'Poster' })
  await expect(button).toHaveAttribute('title', 'Poster: the frame 30% in (default)')

  // The frame at 1 s of the playing video.
  await page.evaluate("document.querySelector('video').currentTime = 1")
  await button.click()
  await page.getByRole('menuitem', { name: 'Use this frame (0:01)' }).click()
  await expect(page.getByText('The poster for v2 is now the frame at 0:01.')).toBeVisible()
  const frame = await posterBody(page)
  expect(frame).toMatchObject({ source: 'frame' })
  expect(frame?.at).toBeCloseTo(1, 1)
  expect(await jpegSize(page, frame?.jpg ?? '')).toEqual([1920, 1080])
  expect(frame?.lqip).toMatch(/^data:image\/(webp|jpeg);base64,/)
  await expect(button).toHaveAttribute('title', 'Poster: the frame at 0:01')

  // An uploaded square image: cropped to the video's 16:9.
  await button.click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: 'Upload an image…' }).click()
  await (await chooser).setFiles({ name: 'square.png', mimeType: 'image/png', buffer: SQUARE_PNG })
  await expect(page.getByText('The poster for v2 is now your image.')).toBeVisible()
  const upload = await posterBody(page)
  expect(upload).toMatchObject({ source: 'upload' })
  expect(await jpegSize(page, upload?.jpg ?? '')).toEqual([1920, 1080])
  await expect(button).toHaveAttribute('title', 'Poster: an uploaded image')

  // Back to the default.
  await button.click()
  await page.getByRole('menuitem', { name: 'Reset to default' }).click()
  await expect(button).toHaveAttribute('title', 'Poster: the frame 30% in (default)')
})

test('video page: the live composition view asks for the Video view to pick a frame', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByText('Live composition').click()
  await page.getByTestId('video-actions').getByRole('button', { name: 'Poster' }).click()
  await expect(page.getByRole('menuitem', { name: /Use this frame/ })).toBeDisabled()
  await expect(page.getByText('Switch to Video to pick a frame.')).toBeVisible()
})

test('editor: the header has the poster menu', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  const button = page.locator('.va-edit-actions').getByRole('button', { name: 'Poster' })
  await button.click()
  await expect(page.getByRole('menuitem', { name: /Use this frame/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Upload an image…' })).toBeVisible()
})
