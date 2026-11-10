import { expect, test } from '@playwright/test'

// The library loads 24 videos at a time and the next 24 when you scroll near the end (mockManyVideos pads it to 60).
test('scrolling to the end of the library loads more videos until there are none left', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockManyVideos', '60'))
  await page.goto('/')
  const tiles = page.locator('.va-tile')
  await expect(tiles).toHaveCount(24)
  await expect(page.getByText(/^24\+ videos/)).toBeVisible()

  // Nothing more loads until you scroll.
  await page.waitForTimeout(500)
  await expect(tiles).toHaveCount(24)

  const more = page.getByTestId('load-more')
  await more.scrollIntoViewIfNeeded()
  await expect(tiles).toHaveCount(48)
  await more.scrollIntoViewIfNeeded()
  await expect(tiles).toHaveCount(60)
  await expect(more).toHaveCount(0)
  await expect(page.getByText(/^60 videos/)).toBeVisible()
})

test('Show more still loads the next page from the keyboard', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockManyVideos', '60'))
  await page.goto('/')
  await expect(page.locator('.va-tile')).toHaveCount(24)
  await page.getByRole('button', { name: 'Show more' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.va-tile')).toHaveCount(48)
})
