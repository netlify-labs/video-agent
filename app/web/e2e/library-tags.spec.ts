import { expect, test, type Page } from '@playwright/test'

// The library has one tag filter (the mock tags Org webhooks launch demo and Ship faster launch). Its list offers
// each tag twice: to show only videos with it, or to hide them. Picks are pills in the field; hidden ones are
// remembered on this device, and demo is hidden until someone removes it.
// A device that has never touched the filter (the config's default clears the hidden tags for the other specs).
test.use({ storageState: { cookies: [], origins: [] } })

const titles = (page: Page) => page.locator('.va-tile .va-card-title')
const pills = (page: Page) => page.getByTestId('tag-filter').locator('.mantine-Pill-root')
/** A pill's ×. Mantine keeps it out of the tab order and the accessibility tree; Backspace does it from the keyboard. */
const removePill = (page: Page, tag: string) =>
  pills(page).filter({ hasText: tag }).locator('.mantine-Pill-remove')
const group = (page: Page, name: string) => page.getByRole('group', { name })

test('demo videos are hidden until the demo pill is removed, and that is remembered', async ({ page }) => {
  await page.goto('/')
  // One tag field, not two.
  await expect(page.getByRole('textbox', { name: 'Tags', exact: true })).toHaveCount(1)
  await expect(page.getByRole('combobox', { name: 'Hide tags' })).toHaveCount(0)
  await expect(pills(page)).toHaveText(['demo'])
  await expect(pills(page).first()).toHaveAttribute('data-hidden', 'true')
  await expect(titles(page)).toHaveCount(6)
  await expect(titles(page).filter({ hasText: 'Org webhooks launch' })).toHaveCount(0)
  // The default isn't called a filter.
  await expect(page.getByText(/^6 videos/)).not.toContainText('in this view')

  await removePill(page, 'demo').click()
  await expect(titles(page)).toHaveCount(7)
  await page.reload()
  await expect(pills(page)).toHaveCount(0)
  await expect(titles(page)).toHaveCount(7)
})

test('type a tag and press Enter to show only it; several tags; × and Backspace remove them', async ({
  page,
}) => {
  await page.goto('/')
  const tags = page.getByRole('textbox', { name: 'Tags', exact: true })
  await tags.click()
  // A whole tag at once (pasted) works like a typed part of one.
  await tags.fill('launch')
  await page.keyboard.press('Enter')
  await expect(titles(page)).toHaveText(['Ship faster with preview deploys'])
  // The field stays one line however many pills it holds: it widens instead.
  const height = async () => (await page.getByTestId('tag-filter').boundingBox())?.height ?? 0
  const oneLine = await height()
  // Asking for a hidden tag shows it anyway.
  await removePill(page, 'demo').click()
  await tags.fill('dem')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(titles(page)).toHaveText(['Ship faster with preview deploys', 'Org webhooks launch'])
  await expect(page.getByText('2 videos in this view.')).toBeVisible()
  await expect(pills(page)).toHaveText(['launch', 'demo'])
  expect(await height()).toBe(oneLine)

  await removePill(page, 'launch').click()
  await expect(titles(page)).toHaveText(['Org webhooks launch'])
  // Backspace in the empty field removes the last pill.
  await tags.click()
  await page.keyboard.press('Backspace')
  await expect(titles(page)).toHaveCount(7)
  await expect(pills(page)).toHaveCount(0)
})

test('the same list hides a tag, and hidden tags come back after a reload', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Tags', exact: true }).click()
  // Both groups list the tags not picked yet, with their counts.
  await expect(group(page, 'Show only').getByRole('option')).toHaveText([/^launch\s*\d+$/])
  await group(page, 'Hide')
    .getByRole('option', { name: /^launch/ })
    .click()
  await page.keyboard.press('Escape')
  await expect(pills(page)).toHaveText(['demo', 'launch'])
  await expect(titles(page)).toHaveCount(5)
  await expect(page.getByText(/^5 videos/)).toContainText('in this view')
  await page.reload()
  await expect(pills(page)).toHaveText(['demo', 'launch'])
  await expect(titles(page)).toHaveCount(5)
})
