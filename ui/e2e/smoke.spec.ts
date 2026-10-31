import { expect, test } from '@playwright/test'

test('library shows videos, progress and the badge', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
  await expect(page.getByText('7 videos, 2 in progress.')).toBeVisible()
  await expect(page.getByText('Making v1')).toBeVisible()
  await expect(page.getByText('Org webhooks launch')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Powered by Netlify Agent Runners' })).toBeVisible()
})

test('search narrows the library', async ({ page }) => {
  await page.goto('/')
  const search = page
    .getByRole('textbox', { name: 'Search prompts and titles' })
    .filter({ visible: true })
    .first()
  await search.fill('docs tutorial')
  await expect(page.getByText('Add an environment variable, then redeploy')).toBeVisible()
  await expect(page.getByText('Org webhooks launch')).toHaveCount(0)
})

test('video page shows the player, versions and the public link', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Ship faster with preview deploys' }),
  ).toBeVisible()
  await expect(page.locator('video')).toBeVisible()
  await expect(page.getByRole('button', { name: /v2 from v1/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Public link for v2')).toBeVisible()
  await page.getByRole('button', { name: /^v1/ }).click()
  await expect(page.getByRole('button', { name: 'Publish v1' })).toBeVisible()
})

test('an in-progress video shows its stage and can be cancelled', async ({ page }) => {
  await page.goto('/videos/vid_making')
  await expect(page.getByText('Making version 1')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Stage: Making' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Make v2' })).toBeDisabled()
})

test('a failed video explains why and offers Try again', async ({ page }) => {
  await page.goto('/videos/vid_failed')
  await expect(page.getByText(/stopped to ask a question/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
})

test('new video form validates and picks a shape', async ({ page }) => {
  await page.goto('/new')
  const make = page.getByRole('button', { name: 'Plan it first' })
  await expect(make).toBeDisabled()
  await page
    .getByLabel('What should the video show?')
    .fill('A 20-second launch video for our new feature, ending with "Try it today".')
  await page.getByRole('radio', { name: /Vertical/ }).click()
  await expect(page.getByRole('radio', { name: /Vertical/ })).toHaveAttribute('aria-checked', 'true')
  await expect(make).toBeEnabled()
})

test('Plan it first asks questions, writes an editable brief, and creates the video with it', async ({
  page,
}) => {
  await page.goto('/new')
  await page
    .getByLabel('What should the video show?')
    .fill('A 30-second launch video for org-wide webhooks, ending on our logo.')
  await page.getByRole('button', { name: 'Plan it first' }).click()
  await expect(page.getByText('Who is this video for?')).toBeVisible()
  await page.getByRole('radio', { name: /Developers/ }).click()
  await page.getByPlaceholder('Other…').first().fill('Platform engineers too')
  await page.getByRole('checkbox', { name: 'Skip' }).nth(1).check()
  await page.getByRole('button', { name: 'Done: write the brief' }).click()
  await expect(page.getByLabel('Call to action')).toHaveValue('Read the docs')
  await page.getByLabel('Call to action').fill('Start free today')
  await page.getByRole('button', { name: 'Create video' }).click()
  await expect(page).toHaveURL(/\/videos\//)
})

test('Create now skips planning', async ({ page }) => {
  await page.goto('/new')
  await page
    .getByLabel('What should the video show?')
    .fill('A 20-second launch video for our new feature, ending with "Try it today".')
  await page.getByRole('button', { name: 'Create now' }).click()
  await expect(page).toHaveURL(/\/videos\//)
})

test('API docs are embedded with the REST reference and MCP setup', async ({ page }) => {
  await page.goto('/docs')
  await expect(page.getByRole('heading', { level: 1, name: 'API docs' })).toBeVisible()
  await expect(page.getByText('Video Agent API').first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('tab', { name: 'MCP for AI tools' }).click()
  await expect(page.getByText('claude mcp add --transport http video-agent', { exact: false })).toBeVisible()
  await expect(page.getByText('create_video')).toBeVisible()
})

test('admin, keys and setup render', async ({ page }) => {
  await page.goto('/admin')
  await expect(
    page.getByText('1 of 3 run slots in use, 1 queued, 1 failure in the last 7 days.'),
  ).toBeVisible()
  await expect(page.getByText('Deploy rollbacks in one click')).toBeVisible()
  await page.goto('/keys')
  await expect(page.getByText('Release pipeline')).toBeVisible()
  await page.goto('/setup')
  await expect(page.getByText('Everything needed is in place. People can make videos.')).toBeVisible()
})
