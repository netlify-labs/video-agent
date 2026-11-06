// WebMCP (va-qago) on the mock build, through a fake document.modelContext: each page registers only its own tools,
// they drive the same controls and API calls a person's clicks use, and anything consequential waits for the person.
import { expect, test } from '@playwright/test'
import { annotations, callTool, installFakeModelContext, toolNames, waitForTools } from './webmcp-fake'

test.beforeEach(async ({ page }) => {
  await installFakeModelContext(page)
})

test('the library offers its tools and the global ones; list_videos drives the real search and filters', async ({
  page,
}) => {
  await page.goto('/')
  await waitForTools(page, ['get_page', 'navigate', 'list_videos', 'open_video'])
  expect(await annotations(page, 'list_videos')).toEqual({
    readOnlyHint: true,
    untrustedContentHint: true,
    consequentialHint: false,
  })
  expect(await callTool(page, 'get_page')).toMatchObject({ ok: true, page: 'library', path: '/' })
  const found = await callTool<{ ok: boolean; videos: { video_id: string; title: string }[] }>(
    page,
    'list_videos',
    {
      query: 'rollbacks',
    },
  )
  expect(found.ok).toBe(true)
  expect(found.videos.map((v) => v.video_id)).toEqual(['vid_making'])
  // The person sees the same search.
  await expect(page.getByPlaceholder('Search prompts and titles').first()).toHaveValue('rollbacks')
  expect(await callTool(page, 'list_videos', { mine: true, favorites: true })).toMatchObject({
    ok: false,
    error: { code: 'invalid_input' },
  })
  expect(await callTool(page, 'list_videos', { status: 'done' })).toMatchObject({
    ok: false,
    error: { code: 'invalid_input', message: expect.stringContaining('status must be one of') as string },
  })
})

test('open_video and navigate move the page, and its tools follow', async ({ page }) => {
  await page.goto('/')
  await waitForTools(page, ['open_video'])
  expect(await callTool(page, 'open_video', { video_id: 'vid_docs' })).toEqual({
    ok: true,
    page: 'video',
    video_id: 'vid_docs',
  })
  await expect(page).toHaveURL(/\/videos\/vid_docs$/)
  await expect.poll(() => toolNames(page)).not.toContain('list_videos')
  expect(await callTool(page, 'navigate', { page: 'editor' })).toMatchObject({
    ok: false,
    error: { code: 'invalid_input', message: 'editor needs video_id.' },
  })
  await callTool(page, 'navigate', { page: 'new_video' })
  await expect(page).toHaveURL(/\/new$/)
})

test('an admin turning WebMCP off registers nothing', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockWebMcpOff', '1'))
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(await toolNames(page)).toEqual([])
})

test('New video: fill_video_form fills what the person sees; create_video waits for their click', async ({
  page,
}) => {
  await page.goto('/new')
  await waitForTools(page, ['fill_video_form', 'create_video'])
  expect(await annotations(page, 'create_video')).toEqual({
    readOnlyHint: false,
    untrustedContentHint: false,
    consequentialHint: true,
  })
  expect(
    await callTool(page, 'fill_video_form', {
      prompt: 'A launch video for org webhooks, with an end card.',
      sound: 'music',
    }),
  ).toEqual({ ok: true, filled: ['prompt', 'sound'] })
  await expect(page.getByLabel('What should the video show?')).toHaveValue(
    'A launch video for org webhooks, with an end card.',
  )
  // An unknown look is refused before anyone is asked.
  expect(
    await callTool(page, 'create_video', { prompt: 'A launch video for org webhooks.', look: 'neon' }),
  ).toMatchObject({
    ok: false,
    error: { code: 'invalid_input', message: 'There\'s no look "neon" here.' },
  })
  await expect(page.getByRole('dialog', { name: /An AI agent wants to/ })).toHaveCount(0)

  // Declined: nothing is created.
  const declined = callTool(page, 'create_video', {
    prompt: 'A launch video for org webhooks.',
    aspect: '9:16',
  })
  const dialog = page.getByRole('dialog', { name: 'An AI agent wants to: Create a video' })
  await expect(dialog).toContainText('Make a new 9:16 video: "A launch video for org webhooks."')
  await dialog.getByRole('button', { name: "Don't allow" }).click()
  expect(await declined).toMatchObject({ ok: false, error: { code: 'declined' } })
  await expect(page).toHaveURL(/\/new$/)

  // Allowed: the same request as Create it now, and the page opens the new video.
  const allowed = callTool(page, 'create_video', {
    prompt: 'A launch video for org webhooks.',
    sound: 'music',
  })
  await dialog.getByRole('button', { name: 'Create video' }).click()
  const result = (await allowed) as { ok: boolean; video_id: string }
  expect(result).toMatchObject({ ok: true, status: 'queued' })
  await expect(page).toHaveURL(new RegExp(`/videos/${result.video_id}$`))
})
