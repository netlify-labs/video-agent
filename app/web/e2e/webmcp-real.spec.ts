// WebMCP for real (va-qago.5): Chromium's own document.modelContext (--enable-features=WebMCPTesting, the flag behind
// about:flags#enable-webmcp-testing), not the fake. Tools are listed and run through getTools and executeTool, as a
// browser agent's host does, and a consequential tool still waits for the person's click. Skipped where the browser
// doesn't expose WebMCP (a local Chrome without the feature).
import { expect, test, type Page } from '@playwright/test'

test.use({ launchOptions: { args: ['--enable-features=WebMCPTesting'] } })
test.skip(({ isMobile }) => isMobile, 'One real run is enough; the phone layout is covered with the fake.')

const real = (page: Page) => page.evaluate<boolean>("typeof document.modelContext === 'object'")
const names = (page: Page) =>
  page.evaluate<string[]>('document.modelContext.getTools().then((ts) => ts.map((t) => t.name).sort())')
const annotations = (page: Page, name: string) =>
  page.evaluate<Record<string, boolean>>(
    `document.modelContext.getTools().then((ts) => ts.find((t) => t.name === ${JSON.stringify(name)}).annotations)`,
  )
/** executeTool resolves to the JSON string the browser made of the result. */
const run = async <T = Record<string, unknown>>(page: Page, name: string, input: object = {}) =>
  JSON.parse(
    await page.evaluate<string>(
      `document.modelContext.getTools().then((ts) => document.modelContext.executeTool(ts.find((t) => t.name === ${JSON.stringify(name)}), ${JSON.stringify(input)}))`,
    ),
  ) as T

test('a real browser lists the page tools, runs them, and keeps consequential ones behind the person', async ({
  page,
}) => {
  await page.goto('/')
  test.skip(!(await real(page)), "This browser doesn't expose document.modelContext.")
  await expect
    .poll(() => names(page))
    .toEqual(expect.arrayContaining(['get_page', 'list_videos', 'navigate', 'open_video']))
  expect(await annotations(page, 'list_videos')).toMatchObject({
    readOnlyHint: true,
    untrustedContentHint: true,
    consequentialHint: false,
  })
  const found = await run<{ ok: boolean; videos: { video_id: string }[] }>(page, 'list_videos', {
    query: 'rollbacks',
  })
  expect(found.videos.map((v) => v.video_id)).toEqual(['vid_making'])
  expect(await run(page, 'list_videos', { nope: 1 })).toMatchObject({
    ok: false,
    error: { code: 'invalid_input' },
  })

  // Moving page unregisters the library's tools (their signals abort) and registers the next page's.
  await run(page, 'navigate', { page: 'new_video' })
  await expect.poll(() => names(page)).toContain('create_video')
  expect(await names(page)).not.toContain('list_videos')
  expect(await annotations(page, 'create_video')).toMatchObject({ consequentialHint: true })

  const created = page.evaluate<string>(
    `document.modelContext.getTools().then((ts) => document.modelContext.executeTool(ts.find((t) => t.name === 'create_video'), { prompt: 'A launch video for org webhooks, with an end card.' }))`,
  )
  const dialog = page.getByRole('dialog', { name: 'An AI agent wants to: Create a video' })
  await dialog.getByRole('button', { name: 'Create video' }).click()
  const made = JSON.parse(await created) as { ok: boolean; video_id: string }
  expect(made.ok).toBe(true)
  await expect(page).toHaveURL(new RegExp(`/videos/${made.video_id}$`))
})
