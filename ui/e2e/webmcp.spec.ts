// WebMCP (va-qago) on the mock build, through a fake document.modelContext: each page registers only its own tools,
// they drive the same controls and API calls a person's clicks use, and anything consequential waits for the person.
import { expect, test } from '@playwright/test'
import { annotations, callTool, installFakeModelContext, toolNames, waitForTools } from './webmcp-fake.js'

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
    error: { code: 'invalid_input', message: expect.stringContaining('status must be one of') },
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

test('the video page: get_video, comments, versions and the player', async ({ page }) => {
  await page.goto('/videos/vid_docs')
  await waitForTools(page, ['get_video', 'list_comments', 'show_version', 'control_player', 'add_comment'])
  // The library's tools went away with the library.
  expect(await toolNames(page)).not.toContain('list_videos')
  const v = await callTool<{
    ok: boolean
    video_id: string
    versions: { version: number; status: string }[]
  }>(page, 'get_video')
  expect(v).toMatchObject({ ok: true, video_id: 'vid_docs', on_screen: 1 })
  expect(v.versions[0]).toMatchObject({ version: 1, status: 'ready' })
  expect(await callTool(page, 'show_version', { version: 9 })).toMatchObject({
    ok: false,
    error: { code: 'not_found', message: 'This video has no version 9.' },
  })
  const added = await callTool<{ ok: boolean; comment_id: string }>(page, 'add_comment', {
    body: 'Slow the second step down a little.',
    time_sec: 4,
  })
  expect(added.ok).toBe(true)
  await expect(page.getByText('Slow the second step down a little.').first()).toBeVisible()
  const comments = await callTool<{ comments: { body: string }[] }>(page, 'list_comments')
  expect(comments.comments.map((c) => c.body)).toContain('Slow the second step down a little.')
  expect(await callTool(page, 'control_player', { action: 'seek' })).toMatchObject({
    ok: false,
    error: { code: 'invalid_input', message: 'seek needs seconds.' },
  })
  const seek = await callTool(page, 'control_player', { action: 'seek', seconds: 2 })
  expect(seek).toMatchObject({ ok: true, playing: false })
})

test('the video page: publish and remix wait for the person, and do what the buttons do', async ({
  page,
}) => {
  await page.goto('/videos/vid_docs')
  await waitForTools(page, ['publish_video', 'remix_video', 'revise_video', 'restyle_video'])
  for (const name of ['publish_video', 'unpublish_video', 'remix_video', 'revise_video', 'restyle_video'])
    expect(await annotations(page, name)).toMatchObject({ consequentialHint: true })
  const dialog = page.getByRole('dialog', { name: /An AI agent wants to/ })

  const declined = callTool(page, 'revise_video', { prompt: 'Make the end card orange.' })
  await expect(dialog).toContainText('Make the next version from v1: "Make the end card orange."')
  await dialog.getByRole('button', { name: "Don't allow" }).click()
  expect(await declined).toMatchObject({ ok: false, error: { code: 'declined' } })

  const published = callTool(page, 'publish_video', {})
  await expect(dialog).toContainText('Publish v1 of "Add an environment variable, then redeploy"')
  await dialog.getByRole('button', { name: 'Publish' }).click()
  expect(await published).toMatchObject({ ok: true, version: 1, published: true })
  await expect
    .poll(
      async () =>
        (await callTool<{ versions: { public: boolean }[] }>(page, 'get_video')).versions[0]?.public,
    )
    .toBe(true)

  const remixed = callTool(page, 'remix_video', { prompt: 'The same tutorial for adding a domain.' })
  await dialog.getByRole('button', { name: 'Remix' }).click()
  const made = (await remixed) as { ok: boolean; video_id: string }
  expect(made.ok).toBe(true)
  await expect(page).toHaveURL(new RegExp(`/videos/${made.video_id}$`))
})

test('the editor: scenes, words, lengths and order change through the editor, and render waits for the person', async ({
  page,
}) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await waitForTools(page, [
    'list_scenes',
    'edit_text',
    'set_scene_duration',
    'reorder_scenes',
    'delete_scene',
    'seek',
    'select_clip',
    'undo',
    'redo',
    'render_edit',
  ])
  expect(await annotations(page, 'list_scenes')).toMatchObject({
    readOnlyHint: true,
    untrustedContentHint: true,
  })
  expect(await annotations(page, 'render_edit')).toMatchObject({ consequentialHint: true })
  expect(await annotations(page, 'delete_scene')).toMatchObject({ consequentialHint: true })
  const listed = await callTool<{
    scenes: { id: string; seconds: number; texts: { id: string; text: string }[] }[]
  }>(page, 'list_scenes')
  const [first, second] = listed.scenes
  if (!first || !second) throw new Error('the fixture has at least two scenes')
  const field = first.texts[0]
  if (!field) throw new Error('the first scene has a text field')

  // Words: the same field the person types in.
  expect(await callTool(page, 'edit_text', { text_id: field.id, text: 'Ship faster with WebMCP' })).toEqual({
    ok: true,
    text_id: field.id,
    text: 'Ship faster with WebMCP',
  })
  // The person's own field shows it.
  await expect
    .poll(() =>
      page.evaluate(
        "[...document.querySelectorAll('input, textarea')].some((el) => el.value === 'Ship faster with WebMCP')",
      ),
    )
    .toBe(true)
  expect(await callTool(page, 'edit_text', { text_id: 'nope', text: 'x' })).toMatchObject({
    ok: false,
    error: { code: 'not_found' },
  })

  // Length and order.
  await callTool(page, 'set_scene_duration', { scene: first.id, seconds: 3.5 })
  const order = [second.id, first.id, ...listed.scenes.slice(2).map((b) => b.id)]
  expect(await callTool(page, 'reorder_scenes', { order: [first.id] })).toMatchObject({
    ok: false,
    error: { code: 'invalid_input', message: 'order must list every scene id exactly once.' },
  })
  await callTool(page, 'reorder_scenes', { order })
  const after = await callTool<{ scenes: { id: string; seconds: number; texts: { text: string }[] }[] }>(
    page,
    'list_scenes',
  )
  expect(after.scenes.map((b) => b.id)).toEqual(order)
  expect(after.scenes[1]).toMatchObject({ id: first.id, seconds: 3.5 })
  expect(after.scenes[1]?.texts[0]?.text).toBe('Ship faster with WebMCP')

  // Deleting asks the person.
  const dialog = page.getByRole('dialog', { name: /An AI agent wants to/ })
  const deleted = callTool(page, 'delete_scene', { scene: second.id })
  await dialog.getByRole('button', { name: "Don't allow" }).click()
  expect(await deleted).toMatchObject({ ok: false, error: { code: 'declined' } })

  // The timeline: nothing to undo yet, and a clip that isn't there.
  expect(await callTool(page, 'undo')).toMatchObject({ ok: false, error: { code: 'nothing_to_undo' } })
  expect(await callTool(page, 'select_clip', { clip_id: 'nope' })).toMatchObject({
    ok: false,
    error: { code: 'not_found' },
  })
  expect(await callTool(page, 'seek', { seconds: 2 })).toMatchObject({ ok: true })

  // Render: the person's click, then the Render button's request.
  const rendered = callTool(page, 'render_edit')
  await expect(dialog).toContainText('Render your edits as v3.')
  await dialog.getByRole('button', { name: 'Render as v3' }).click()
  expect(await rendered).toMatchObject({ ok: true, version: 3, status: 'queued' })
  await expect(page).toHaveURL(/\/videos\/vid_teaser$/)
})
