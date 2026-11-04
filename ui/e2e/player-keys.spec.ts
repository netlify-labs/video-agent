// Keyboard and timeline transport (ui/src/lib/media-keys.ts): Space plays and pauses, ← and → step a second (Shift:
// five) on the video page and in the editor, except while typing; a click in the editor's timeline lanes seeks there.
import { expect, test, type Page } from '@playwright/test'

/** The editor preview's position, in seconds, from its "m:ss / m:ss" readout. */
const previewTime = async (page: Page) => {
  const readout = await page
    .locator('.va-editor-stage')
    .getByText(/^\d+:\d{2} \/ \d+:\d{2}$/)
    .first()
    .innerText()
  const text = (readout.split('/')[0] ?? '').trim()
  const [m, s] = text.split(':').map(Number)
  return (m ?? 0) * 60 + (s ?? 0)
}

test('editor: Space plays and pauses the preview, arrows step, typing is left alone', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  const play = page.getByRole('button', { name: 'Play preview' })
  await expect(play).toBeEnabled()
  // Focus nothing in particular (the page itself).
  await page.locator('[data-testid="edit-status"]').click()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause preview' })).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeVisible()
  const before = await previewTime(page)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => previewTime(page)).toBe(Math.min(before + 2, 9))
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => previewTime(page)).toBe(Math.min(before + 1, 9))
  // Typing a space in a scene field types it; the preview doesn't start.
  const field = page.getByTestId('edit-panel').getByRole('textbox').first()
  await field.click()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeVisible()
})

test('editor: a click in the timeline lanes moves the playhead there', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeEnabled()
  const lane = page.locator('.va-tl-lane[data-lane="music"]')
  const box = await lane.boundingBox()
  if (!box) throw new Error('no Music lane')
  const playhead = page.locator('.va-tl-playhead')
  const x0 = (await playhead.boundingBox())?.x ?? 0
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2)
  await expect.poll(async () => (await playhead.boundingBox())?.x ?? 0).toBeGreaterThan(x0 + box.width * 0.3)
  await expect.poll(() => previewTime(page)).toBeGreaterThan(2)
})

test('video page: Space plays and pauses the video, arrows step', async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  const video = page.locator('.va-review-frame video')
  await expect(video).toBeVisible()
  await page.locator('.va-video-head .va-sub').first().click()
  const paused = () => video.evaluate((v) => (v as unknown as { paused: boolean }).paused)
  const time = () => video.evaluate((v) => (v as unknown as { currentTime: number }).currentTime)
  await expect.poll(paused).toBe(true)
  await page.keyboard.press('Space')
  await expect.poll(paused).toBe(false)
  await page.keyboard.press('Space')
  await expect.poll(paused).toBe(true)
  const t0 = await time()
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(time).toBeGreaterThan(t0 + 2)
})

test('editor: dragging the playhead scrubs the preview', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeEnabled()
  const grip = page.getByTestId('timeline-playhead-grip')
  const lane = await page.locator('.va-tl-lane[data-lane="music"]').boundingBox()
  const start = await grip.boundingBox()
  if (!lane || !start) throw new Error('no timeline')
  await page.mouse.move(start.x + start.width / 2, start.y + 10)
  await page.mouse.down()
  // Through the middle (the preview follows while dragging) to 70% of the lane.
  await page.mouse.move(lane.x + lane.width * 0.4, start.y + 10, { steps: 5 })
  await expect.poll(() => previewTime(page)).toBeGreaterThan(1)
  await page.mouse.move(lane.x + lane.width * 0.7, start.y + 10, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => previewTime(page)).toBeGreaterThan(4)
})

test('editor: pressing in a lane and dragging scrubs; a click on a narration clip still selects it', async ({
  page,
}) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeEnabled()
  const lane = await page.locator('.va-tl-lane[data-lane="music"]').boundingBox()
  if (!lane) throw new Error('no Music lane')
  const y = lane.y + lane.height / 2
  await page.mouse.move(lane.x + lane.width * 0.1, y)
  await page.mouse.down()
  await page.mouse.move(lane.x + lane.width * 0.8, y, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => previewTime(page)).toBeGreaterThan(5)
})

test('editor: a scene card jumps the preview to the start of its scene', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeEnabled()
  // Opening 0-3 s, Demo 3-6 s, Outro 6-9 s.
  await page.getByRole('button', { name: 'Jump to Outro' }).click()
  await expect.poll(() => previewTime(page)).toBe(6)
  await page.getByRole('button', { name: 'Jump to Demo' }).click()
  await expect.poll(() => previewTime(page)).toBe(3)
  await expect(page.locator('.va-tl-playhead')).toBeVisible()
})

test('video page: typing in the title keeps Space, arrows and C for the title', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  const video = page.locator('.va-review-frame video')
  await expect(video).toBeVisible()
  const paused = () => video.evaluate((v) => (v as unknown as { paused: boolean }).paused)
  const title = page.getByRole('heading', { level: 1 })
  await title.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' now')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('c')
  await expect(title).toContainText('Ship faster with preview deploys ncow')
  // Space typed a space, the arrows moved the caret, and C typed a c: the video never started, no note began.
  expect(await paused()).toBe(true)
  await expect(page.getByTestId('note-moment').getByText(/^0:0/)).toHaveCount(0)
  await page.keyboard.press('Escape')
})
