import { expect, test, type Page } from '@playwright/test'

// The library's tag filters take several tags as pills (the mock tags Org webhooks launch demo and Ship faster
// launch). Tags shows videos with any of them; Hide tags leaves those out and is remembered on this device.
const titles = (page: Page) => page.locator('.va-tile .va-card-title')
/** A pill's ×. Mantine keeps it out of the tab order and the accessibility tree; Backspace does it from the keyboard. */
const removePill = (page: Page, tag: string) =>
  page.locator('.mantine-Pill-root', { hasText: tag }).locator('.mantine-Pill-remove')

test('tag filters take several tags as pills, and a pill’s × removes it', async ({ page }) => {
  await page.goto('/')
  await expect(titles(page)).toHaveCount(7)
  const tags = page.getByRole('combobox', { name: 'Tags', exact: true })
  await tags.click()
  await tags.fill('dem')
  await page.keyboard.press('Enter')
  await expect(titles(page)).toHaveText(['Org webhooks launch'])
  await tags.fill('laun')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(titles(page)).toHaveText(['Ship faster with preview deploys', 'Org webhooks launch'])
  await expect(page.getByText('2 videos in this view.')).toBeVisible()

  await removePill(page, 'demo').click()
  await expect(titles(page)).toHaveText(['Ship faster with preview deploys'])
  // Backspace in the empty field removes the last pill.
  await tags.click()
  await page.keyboard.press('Backspace')
  await expect(titles(page)).toHaveCount(7)
  await expect(page.locator('.mantine-Pill-root')).toHaveCount(0)
})

test('Hide tags leaves out every tag picked, and remembers them after a reload', async ({ page }) => {
  await page.goto('/')
  const hide = page.getByRole('combobox', { name: 'Hide tags', exact: true })
  await hide.click()
  await page.getByRole('option', { name: /^demo/ }).click()
  await page.getByRole('option', { name: /^launch/ }).click()
  await page.keyboard.press('Escape')
  await expect(titles(page)).toHaveCount(5)
  await page.reload()
  await expect(page.locator('.mantine-Pill-root')).toHaveText(['demo', 'launch'])
  await expect(titles(page)).toHaveCount(5)
  // Asking for a hidden tag shows it anyway.
  await page.getByRole('combobox', { name: 'Tags', exact: true }).fill('demo')
  await page.keyboard.press('Enter')
  await expect(titles(page)).toHaveText(['Org webhooks launch'])
})
