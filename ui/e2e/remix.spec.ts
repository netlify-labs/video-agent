// Remix in the web app (docs/plans/2026-11-03-remix.md §3.7; bead va-p62w.4.7, the phase 4 gate), against the mock
// build: the dialog from the video page, the Library tile menu, New video's "Start from an existing video", the ?remix
// deep link, the admin switch and roles. The share page's link is covered in test/remix-share.test.ts.
import { expect, test, type Page } from '@playwright/test'

const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })
const lastRemix = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __lastRemix?: Record<string, unknown> }).__lastRemix)

test('video page: Remix opens the dialog with the source settings, and makes a new video', async ({
  page,
}) => {
  await page.goto('/videos/vid_webhooks')
  await page.getByRole('button', { name: 'Remix', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Remix Org webhooks launch v1/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('What would you change?')).toBeEmpty()
  await expect(dialog.getByText('Be as descriptive as possible')).toBeVisible()
  // The source's prompts are there, collapsed.
  await dialog.getByText('What this video was made from').click()
  await expect(dialog.locator('.va-remix-source')).toBeVisible()
  // The source's media are chips; Remix needs words first.
  await expect(dialog.locator('.va-media-chip')).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: 'Remix', exact: true })).toBeDisabled()
  // A new shape warns.
  await dialog.getByLabel('Shape').click()
  await page.getByRole('option', { name: '9:16 vertical' }).click()
  await expect(dialog.getByText('the agent will re-lay out every scene')).toBeVisible()
  await dialog.getByLabel('What would you change?').fill('Same format, about the payments API.')
  await dialog.getByRole('button', { name: 'Remix', exact: true }).click()
  await expect(page).toHaveURL(/\/videos\/vid_remix_\d+$/)
  expect(await lastRemix(page)).toMatchObject({
    sourceId: 'vid_webhooks',
    prompt: 'Same format, about the payments API.',
    fromVersion: 1,
    aspect: '9:16',
  })
  // Unchanged media isn't sent (the server keeps the source's set).
  expect(await lastRemix(page)).not.toHaveProperty('mediaIds')
  await expect(page.getByTestId('remix-of')).toContainText('Remix of Org webhooks launch v1')
})

test('removing a source chip sends the final media list', async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  await page.getByRole('button', { name: 'Remix', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.va-media-chip')).toHaveCount(1)
  await dialog.locator('.va-media-chip').getByRole('button').click()
  await expect(dialog.locator('.va-media-chip')).toHaveCount(0)
  await dialog.getByLabel('What would you change?').fill('Without the logo.')
  await dialog.getByRole('button', { name: 'Remix', exact: true }).click()
  await expect(page).toHaveURL(/\/videos\/vid_remix_\d+$/)
  expect(await lastRemix(page)).toMatchObject({ mediaIds: [] })
})

test('a narrated source says its recorded narration is not carried over', async ({ page }) => {
  await page.goto('/videos/vid_sales')
  await page.getByRole('button', { name: 'Remix', exact: true }).click()
  await expect(page.getByRole('dialog').getByText('recorded narration isn’t carried over')).toBeVisible()
})

test('the ?remix deep link (from the share page) opens the dialog, once', async ({ page }) => {
  await page.goto('/videos/vid_webhooks?remix=1')
  await expect(page.getByRole('dialog', { name: /Remix Org webhooks launch v1/ })).toBeVisible()
  await expect(page).toHaveURL(/\/videos\/vid_webhooks$/)
})

test('Library: the tile menu remixes without opening the video; remixes say so', async ({ page }) => {
  await page.goto('/')
  const tile = page.locator('.va-tile', { hasText: 'Org webhooks launch' })
  await tile.hover()
  await tile.getByRole('button', { name: 'More for Org webhooks launch' }).click()
  await page.getByRole('menuitem', { name: 'Remix' }).click()
  await expect(page.getByRole('dialog', { name: /Remix Org webhooks launch v1/ })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
  await page.keyboard.press('Escape')
  const remixTile = page.locator('.va-tile', { hasText: 'Add an environment variable' })
  await expect(remixTile.locator('.va-meta')).toContainText('Remix')
})

test('New video: start from an existing video, pick one, and go back to scratch', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('button', { name: 'Start from an existing video' }).click()
  const picker = page.getByRole('dialog', { name: 'Start from an existing video' })
  await picker.getByText('Favorites').click()
  await expect(picker.getByText('No favorites yet')).toBeVisible()
  await picker.getByText('Everyone').click()
  await picker.getByRole('option', { name: /Org webhooks launch/ }).click()
  await picker.getByRole('button', { name: 'Remix this' }).click()
  await expect(page.getByText('Starting from Org webhooks launch v1')).toBeVisible()
  await expect(page.getByTestId('remix-form')).toBeVisible()
  await page.getByRole('button', { name: 'Start from scratch' }).click()
  await expect(page.getByLabel('What should the video show?')).toBeVisible()
})

test('turned off by an admin, or for a viewer, Remix is offered nowhere', async ({ page }) => {
  await mock(page, 'mockRemixOff')
  await page.goto('/videos/vid_webhooks')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remix', exact: true })).toHaveCount(0)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'More for Org webhooks launch' })).toHaveCount(0)
  await page.goto('/new')
  await expect(page.getByLabel('What should the video show?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start from an existing video' })).toHaveCount(0)
})

test('viewers get no Remix', async ({ page }) => {
  await mock(page, 'mockRole', 'viewer')
  await page.goto('/videos/vid_webhooks')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remix', exact: true })).toHaveCount(0)
})

test('admins switch remixing off and on in Settings', async ({ page }) => {
  await page.goto('/admin')
  const sw = page.getByRole('switch', { name: 'People can remix videos' })
  await expect(sw).toBeChecked()
  await sw.click({ force: true })
  await expect(sw).not.toBeChecked()
})

test('New video: a recent video’s Remix button starts the remix form from it', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('button', { name: 'Remix Ship faster with preview deploys' }).click()
  await expect(page.getByText(/Starting from Ship faster with preview deploys v\d/)).toBeVisible()
  await expect(page.getByTestId('remix-form')).toBeVisible()
})

test('video page: favorite, remix and download sit above the player as labelled icons', async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  const row = page.getByTestId('video-actions')
  await expect(row.getByRole('button', { name: 'Add to favorites' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Remix', exact: true })).toHaveAttribute(
    'title',
    /make a new video of your own from this one/,
  )
  await expect(row.getByRole('link', { name: 'Download the MP4' })).toHaveAttribute('href', /\.mp4|video/)
  await row.getByRole('button', { name: 'Add to favorites' }).click()
  await expect(row.getByRole('button', { name: 'Remove from favorites' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('version details say what a version sounds like, silent included', async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  const details = page.locator('.mantine-Card-root', { hasText: 'Details for v1' })
  await expect(details.getByText('Sound', { exact: true })).toBeVisible()
})
