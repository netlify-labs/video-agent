// Reviewing while watching (Review.tsx CommentsCard): C pauses and starts a note at that moment, Enter adds it and
// steps out of the box so Space keeps playing, a spot can be marked and removed, and the notes post together as one
// block. The composer sits above the comments, newest first, and a timed comment seeks the player when clicked.
import { expect, test, type Page } from '@playwright/test'

const video = (page: Page) => page.locator('.va-review-frame video')
const paused = (page: Page) => video(page).evaluate((v) => (v as unknown as { paused: boolean }).paused)
const at = (page: Page) => video(page).evaluate((v) => (v as unknown as { currentTime: number }).currentTime)
const seekTo = (page: Page, t: number) =>
  video(page).evaluate((v, s) => {
    ;(v as unknown as { currentTime: number }).currentTime = s
  }, t)

test('C notes the moment, Enter adds it, Space keeps watching; the notes post as one block', async ({
  page,
}) => {
  await page.goto('/videos/vid_webhooks')
  await page.waitForFunction("(document.querySelector('.va-review-frame video')?.readyState ?? 0) >= 1")
  const box = page.getByRole('textbox', { name: 'Add a comment' })

  // First note at 0:02, with a spot.
  await seekTo(page, 2)
  await page.getByRole('heading', { level: 1 }).click()
  await page.keyboard.press('Space')
  await expect.poll(() => paused(page)).toBe(false)
  await page.keyboard.press('c')
  await expect.poll(() => paused(page)).toBe(true)
  await expect(box).toBeFocused()
  await expect(page.getByText(/^0:0[2-3]$/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Mark a spot' }).click()
  const capture = page.getByTestId('pin-capture')
  const r = await capture.boundingBox()
  if (!r) throw new Error('no frame')
  await capture.click({ position: { x: r.width / 2, y: r.height / 2 } })
  await expect(page.getByText('spot marked')).toBeVisible()
  // The spot can be taken off again, and put back.
  await page.getByRole('button', { name: 'Remove spot' }).click()
  await expect(page.getByText('spot marked')).toHaveCount(0)
  await page.getByRole('button', { name: 'Mark a spot' }).click()
  await capture.click({ position: { x: r.width / 2, y: r.height / 2 } })
  await box.click()
  await box.fill('Logo too small here')
  await box.press('Enter')
  await expect(page.getByTestId('draft-notes')).toContainText('Logo too small here')
  await expect(box).not.toBeFocused()
  // Space plays again from the note.
  await page.keyboard.press('Space')
  await expect.poll(() => paused(page)).toBe(false)

  // Second note at 0:05, no spot.
  await page.keyboard.press('Space')
  await seekTo(page, 5)
  await page.keyboard.press('c')
  await expect(box).toBeFocused()
  await box.fill('Too fast')
  await box.press('Enter')
  // A plain line too, with no moment (Enter moved the last note's moment off), then post all three together.
  await box.fill('Colours are great overall')
  await expect(page.getByRole('button', { name: 'Post 3 notes' })).toBeVisible()
  await page.getByRole('button', { name: 'Post 3 notes' }).click()

  const lastBatch = () =>
    page.evaluate(
      () =>
        (globalThis as unknown as { __lastBatch?: { versionN: number; notes: unknown[] } }).__lastBatch ??
        null,
    )
  await expect.poll(lastBatch).not.toBeNull()
  const sent = (await lastBatch()) as {
    versionN: number
    notes: { body: string; timeSec?: number | null; x?: number | null }[]
  }
  expect(sent.notes.map((n) => n.body)).toEqual([
    'Logo too small here',
    'Too fast',
    'Colours are great overall',
  ])
  expect(sent.notes[0]?.timeSec).toBeCloseTo(2, 0)
  expect(sent.notes[0]?.x).toBeCloseTo(0.5, 1)
  expect(sent.notes[1]?.timeSec).toBeCloseTo(5, 0)
  expect(sent.notes[2]?.timeSec ?? null).toBeNull()

  // One block, above nothing older (the newest is first), under the composer.
  const block = page.getByTestId('comment-block').first()
  await expect(block).toContainText('Logo too small here')
  await expect(block).toContainText('Too fast')
  await expect(page.getByTestId('draft-notes')).toHaveCount(0)
  const composerTop = (await box.boundingBox())?.y ?? 0
  const blockTop = (await block.boundingBox())?.y ?? 0
  expect(blockTop).toBeGreaterThan(composerTop)

  // Clicking a timed note jumps the video there.
  await seekTo(page, 0)
  await block.getByText('Too fast').click()
  await expect.poll(() => at(page)).toBeCloseTo(5, 0)
})

test('a plain comment still posts with one click, and goes above older ones', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  const box = page.getByRole('textbox', { name: 'Add a comment' })
  await box.fill('Nice pacing')
  await page.getByRole('button', { name: 'Comment', exact: true }).click()
  const first = page.getByTestId('comment').first()
  await expect(first).toContainText('Nice pacing')
  // Typing "c" in the box types it; it doesn't start a note.
  await box.fill('')
  await box.pressSequentially('cool')
  await expect(box).toHaveValue('cool')
})
