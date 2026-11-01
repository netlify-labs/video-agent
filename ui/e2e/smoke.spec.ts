import { expect, test, type Locator, type Page } from '@playwright/test'

/** A DOM property of the element (the specs aren't typechecked against the DOM library). */
const prop = <T>(l: Locator, name: string) =>
  l.evaluate((el, n) => (el as unknown as Record<string, unknown>)[n], name) as Promise<T>

/** Sets a mock API switch in localStorage before the app loads. */
const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })

test('library shows videos, progress and the badge', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
  await expect(page.getByText('7 videos, 2 in progress.')).toBeVisible()
  await expect(page.getByText('Making v1')).toBeVisible()
  await expect(page.getByText('Org webhooks launch')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Powered by Netlify Agent Runners' })).toBeVisible()
})

test('library tiles: small AVIF/WebP posters, and the hover clip is fetched only on hover', async ({
  page,
}) => {
  const clipRequests: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('-clip.')) clipRequests.push(r.url())
  })
  await page.goto('/')
  const tile = page.locator('a.va-card', { hasText: 'Ship faster with preview deploys' })
  const picture = tile.locator('picture')
  await expect(picture.locator('source').first()).toHaveAttribute('type', 'image/avif')
  await expect(picture.locator('source[type="image/avif"]')).toHaveAttribute(
    'srcset',
    '/teaser-v2-poster-480.avif 480w, /teaser-v2-poster-960.avif 960w',
  )
  await expect(picture.locator('source[type="image/webp"]')).toHaveAttribute(
    'sizes',
    /\(max-width: 520px\) 100vw/,
  )
  // The JPEG stays the fallback, and the placeholder goes once the poster has decoded.
  const img = picture.locator('img')
  await expect(img).toHaveAttribute('src', '/teaser-v2.jpg')
  await expect(img).toHaveAttribute('alt', '')
  await expect.poll(() => prop<string>(img, 'currentSrc')).toMatch(/teaser-v2-poster-\d+\.(avif|webp)$/)
  await expect(img).not.toHaveClass(/va-lqip/)
  await expect(tile.locator('video')).toHaveCount(0)
  expect(clipRequests).toEqual([])

  await tile.hover()
  const clip = tile.locator('video')
  await expect(clip).toHaveAttribute('data-playing', 'true')
  await expect(clip).toHaveAttribute('aria-hidden', 'true')
  await expect(clip.locator('source')).toHaveCount(2)
  await expect(clip.locator('source').first()).toHaveAttribute('type', 'video/webm')
  await expect(clip.locator('source').last()).toHaveAttribute('src', '/teaser-v2-clip.mp4')
  for (const p of ['muted', 'loop', 'playsInline']) expect(await prop<boolean>(clip, p)).toBe(true)
  await expect.poll(() => clipRequests.length).toBeGreaterThan(0)

  // Leaving pauses and hides it; it stays mounted, so the next hover doesn't fetch again.
  await page.mouse.move(0, 0)
  await expect(clip).not.toHaveAttribute('data-playing', 'true')
  await expect.poll(() => prop<boolean>(clip, 'paused')).toBe(true)
})

test('library tiles without a clip keep the GIF on hover', async ({ page }) => {
  await page.goto('/')
  const tile = page.locator('a.va-card', { hasText: 'Org webhooks launch' })
  await expect(tile.locator('picture')).toHaveCount(0)
  await expect(tile.locator('img')).toHaveAttribute('src', '/launch-webhooks.jpg')
  await tile.hover()
  await expect(tile.locator('img')).toHaveAttribute('src', '/launch-webhooks.gif')
  await expect(tile.locator('video')).toHaveCount(0)
})

test('the versions list uses the small poster for versions that have one', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  const v2 = page.getByRole('button', { name: /v2 from v1/ })
  await expect(v2.locator('source[type="image/webp"]')).toHaveAttribute('sizes', '112px')
  await expect.poll(() => prop<string>(v2.locator('img'), 'currentSrc')).toMatch(/-poster-480\./)
  await expect(page.getByRole('button', { name: /^v1/ }).locator('picture')).toHaveCount(0)
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
  await expect(page.getByText('create_video', { exact: true })).toBeVisible()
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

// Review (plan v2 §5)
test('comments show on the video, markers seek, and the library shows the unread badge', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('1 unread comments')).toBeVisible()
  await page.goto('/videos/vid_teaser')
  await expect(page.getByText('Comments on v2')).toBeVisible()
  await expect(page.getByText('The logo here is too small to read on a phone.')).toBeVisible()
  await expect(page.getByText('Love the end card.')).toBeVisible()
  await page.waitForFunction("(document.querySelector('video')?.readyState ?? 0) >= 1")
  await page.getByRole('button', { name: 'Comment at 0:01' }).click()
  await expect
    .poll(() => page.evaluate<number>("document.querySelector('video')?.currentTime ?? 0"))
    .toBeCloseTo(1.5, 1)
  await expect(page.getByTestId('pin-dot')).toHaveCount(1)
  // Pins belong to their version only.
  await page.getByRole('button', { name: /^v1/ }).click()
  await expect(page.getByText('Comments on v1')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Comment at 0:01' })).toHaveCount(0)
})

test('a pin lands where you click, inside the letterboxed picture', async ({ page }) => {
  await page.goto('/videos/vid_sales')
  await page.waitForFunction("(document.querySelector('video')?.videoWidth ?? 0) > 0")
  await page.getByRole('button', { name: 'Pin to this moment' }).click()
  const capture = page.getByTestId('pin-capture')
  const r = await capture.boundingBox()
  if (!r) throw new Error('no frame')
  // A 9:16 picture in a 16:9 frame: bars left and right.
  const cw = (r.height * 9) / 16
  const left = (r.width - cw) / 2
  await capture.click({ position: { x: left / 2, y: r.height / 2 } })
  await expect(capture).toBeVisible()
  const target = { x: left + cw * 0.25, y: r.height * 0.75 }
  await capture.click({ position: target })
  await expect(capture).toHaveCount(0)
  const dot = await page.locator('.va-pin-dot-pending').boundingBox()
  if (!dot) throw new Error('no dot')
  expect(Math.abs(dot.x + dot.width / 2 - (r.x + target.x))).toBeLessThan(3)
  expect(Math.abs(dot.y + dot.height / 2 - (r.y + target.y))).toBeLessThan(3)
  await expect(page.getByText('spot marked')).toBeVisible()
  await page.getByRole('textbox', { name: 'Add a comment' }).fill('Move the button up')
  await page.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(page.getByText('Move the button up')).toBeVisible()
  const saved = await page.evaluate(async () => {
    const res = await fetch('/api/v1/videos/vid_sales/comments')
    const body = (await res.json()) as { items: { body: string; x: number; y: number }[] }
    return body.items.find((c) => c.body === 'Move the button up')
  })
  // Within 2 px of the click, measured in the picture (click positions round to whole pixels).
  expect(Math.abs((saved?.x ?? 0) - 0.25) * cw).toBeLessThan(2)
  expect(Math.abs((saved?.y ?? 0) - 0.75) * r.height).toBeLessThan(2)
})

test("approve someone else's version with a note; counts update", async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await page.getByRole('textbox', { name: 'Note (optional)' }).fill('Ship it')
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByRole('button', { name: 'Approved' })).toBeVisible()
  await expect(page.getByText('1 approved')).toBeVisible()
})

test('viewers read comments but cannot comment or approve', async ({ page }) => {
  await mock(page, 'mockRole', 'viewer')
  await page.goto('/videos/vid_teaser')
  await expect(page.getByText('The logo here is too small to read on a phone.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Add a comment' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Comment actions' })).toHaveCount(0)
})

test('the owner incorporates feedback: open comments all checked, plus a note', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByRole('button', { name: 'Incorporate feedback' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('checkbox')).toHaveCount(2)
  for (const box of await dialog.getByRole('checkbox').all()) await expect(box).toBeChecked()
  await dialog.getByRole('checkbox').nth(1).uncheck()
  await dialog.getByRole('textbox', { name: 'Note for the agent (optional)' }).fill('Keep the colours')
  await dialog.getByRole('button', { name: /Make v3 \(1\)/ }).click()
  await expect(dialog).toHaveCount(0)
  const sent = await page.evaluate<{ prompt: string; fromVersion: number; commentIds: string[] }>(
    '(window).__lastRevise',
  )
  expect(sent).toEqual({ prompt: 'Keep the colours', fromVersion: 2, commentIds: ['c_1'] })
})

test('viewers and non-owners get no Incorporate button', async ({ page }) => {
  await mock(page, 'mockRole', 'viewer')
  await page.goto('/videos/vid_teaser')
  await expect(page.getByText('Love the end card.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Incorporate feedback' })).toHaveCount(0)
})

// Live progress (plan v2 §6)
test('narration updates while the run is going, with steps and credits as counts', async ({ page }) => {
  await page.goto('/videos/vid_making')
  const narration = page.getByTestId('narration')
  await expect(narration).toContainText('Working: ')
  await expect(narration).toContainText(/\d+ steps · \d+ credits so far · updated just now/)
  const first = await narration.innerText()
  await expect.poll(() => narration.innerText(), { timeout: 8000 }).not.toBe(first)
  await expect(narration).not.toContainText('%')
})

test('narration polling pauses while the tab is hidden', async ({ page }) => {
  await page.goto('/videos/vid_making')
  await expect(page.getByTestId('narration')).toBeVisible()
  await expect.poll(() => page.evaluate<number>('window.__progressCalls ?? 0')).toBeGreaterThan(0)
  await page.evaluate(`
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  `)
  const calls = () => page.evaluate<number>('window.__progressCalls ?? 0')
  const before = await calls()
  await page.waitForTimeout(7000)
  expect(await calls()).toBe(before)
})

test('a stale update says so', async ({ page }) => {
  await mock(page, 'mockStale')
  await page.goto('/videos/vid_making')
  await expect(page.getByTestId('narration')).toContainText("couldn't reach the run, showing the last update")
  await expect(page.getByTestId('narration')).toContainText('updated 1 min ago')
})

test('render progress shows as Rendering N%', async ({ page }) => {
  await mock(page, 'mockRender')
  await page.goto('/videos/vid_making')
  await expect(page.getByTestId('narration')).toContainText(/Rendering \d+%/)
})

// Composition preview (plan v2 §7)
test('the live composition plays in a sandboxed frame driven over its channel', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByText('Live composition').click()
  const frame = page.getByTestId('composition-preview')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeEnabled()
  await page.getByRole('button', { name: 'Play preview' }).click()
  await expect(page.getByText(/^0:0[1-8] \/ 0:08$/)).toBeVisible()
  await page.getByRole('button', { name: 'Pause preview' }).click()
  await expect(page.getByText('close to, not exactly, the final video')).toBeVisible()
})

test('the app ignores messages that are not from its preview frame and channel', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByText('Live composition').click()
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeEnabled()
  await expect(page.getByText('0:00 / 0:08')).toBeVisible()
  // From the top window itself (wrong source), with and without a plausible channel, and a malformed shape.
  await page.evaluate(`
    window.postMessage({ type: 'time', time: 5, channel: 'guess' }, '*')
    window.postMessage({ type: 'ready', duration: 99 }, '*')
    window.postMessage({ type: 'time', time: 'x' }, '*')
  `)
  await page.waitForTimeout(400)
  await expect(page.getByText('0:00 / 0:08')).toBeVisible()
})

test('the preview link is renewed before it expires, keeping the playhead', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByText('Live composition').click()
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeEnabled()
  await page.getByRole('button', { name: 'Play preview' }).click()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Pause preview' }).click()
  const at = await page.getByText(/ \/ 0:08$/).innerText()
  await expect.poll(() => page.evaluate<number>('window.__previewLinks ?? 0'), { timeout: 12_000 }).toBe(2)
  await expect(page.getByTestId('composition-preview')).toHaveAttribute('src', /link=2/)
  await expect(page.getByText(at)).toBeVisible()
})

test('a running version shows the agent’s latest composition snapshot, refreshed on new checkpoints', async ({
  page,
}) => {
  await mock(page, 'mockLive')
  await page.goto('/videos/vid_making')
  const snap = page.getByTestId('live-snapshot')
  await expect(snap.getByTestId('composition-preview')).toHaveAttribute('src', /live=1/)
  await expect(snap.getByText('a work in progress, not the final video')).toBeVisible()
  const first = await snap.getByTestId('composition-preview').getAttribute('src')
  // The mock's checkpoint seq moves every third poll (3 s apart): a new snapshot remounts the frame.
  await expect
    .poll(() => snap.getByTestId('composition-preview').getAttribute('src'), { timeout: 15_000 })
    .not.toBe(first)
})

// Editor (plan v2 §8)
const lastOps = (page: Page) => page.evaluate<unknown[]>('window.__lastEditOps ?? []')

test('Edit opens the editor for an editable version; others say to revise instead', async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  await page.goto('/videos/vid_teaser')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page).toHaveURL(/\/videos\/vid_teaser\/edit\/2$/)
  await expect(page.getByRole('heading', { name: 'Edit v2' })).toBeVisible()
  for (const b of ['intro', 'demo', 'outro']) await expect(page.getByTestId(`beat-${b}`)).toBeVisible()
  await expect(page.getByTestId('edit-status')).toContainText('9 s · 3 beats · No changes yet')
})

test('editing text, timing, order and colour saves the matching ops; render makes the next version', async ({
  page,
}) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await page.getByRole('textbox', { name: 'Length of Opening' }).fill('4.5')
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  await expect(page.getByTestId('edit-status')).toContainText('10.5 s')
  expect(await lastOps(page)).toEqual([{ op: 'retime', beat: 'intro', duration: 4.5 }])
  await page.getByRole('textbox', { name: 'Call to action' }).fill('Start free today')
  await page.getByRole('button', { name: 'Move Outro earlier' }).click()
  await page.getByRole('button', { name: 'Colour for Accent' }).click()
  await page.getByRole('menuitem', { name: '#ff5a1f' }).click()
  await expect
    .poll(() => lastOps(page), { timeout: 5000 })
    .toEqual([
      { op: 'reorder', order: ['intro', 'outro', 'demo'] },
      { op: 'retime', beat: 'intro', duration: 4.5 },
      { op: 'text', id: 'outro-cta', text: 'Start free today' },
      { op: 'color', role: 'accent', value: '#ff5a1f' },
    ])
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  await page.getByRole('button', { name: 'Render as v3' }).click()
  await expect(page).toHaveURL(/\/videos\/vid_teaser$/)
  expect(await page.evaluate<number>('window.__rendered ?? 0')).toBe(1)
})

test('deleting beats stops at the last one', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await page.getByRole('button', { name: 'Delete demo' }).click()
  await page.getByRole('button', { name: 'Delete outro' }).click()
  await expect(page.getByRole('button', { name: 'Delete Opening' })).toBeDisabled()
  await expect
    .poll(() => lastOps(page), { timeout: 5000 })
    .toEqual([
      { op: 'delete', beat: 'demo' },
      { op: 'delete', beat: 'outro' },
    ])
})

test('clicking text in the preview focuses its field', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  const frame = page.frameLocator('[data-testid="composition-preview"]')
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeEnabled()
  // Dispatched to the element: the frame is CSS-scaled, which throws off pointer coordinates in tests.
  await frame.locator('[data-va-text="outro-cta"]').dispatchEvent('click')
  await expect(page.getByRole('textbox', { name: 'Call to action' })).toBeFocused()
})

// Media library (plan v2 §9)
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 128, 0, 0, 1,
  104, 8, 6, 0, 0, 0,
])
const pngFile = (name = 'logo.png') => ({ name, mimeType: 'image/png', buffer: pngBytes })

test('the media library starts empty, uploads a file, edits its caption and deletes it', async ({ page }) => {
  await page.goto('/media')
  await expect(page.getByText('Nothing here yet')).toBeVisible()
  await page.locator('input[type=file]').setInputFiles(pngFile())
  const card = page.getByTestId('media-med_mock0001')
  await expect(card.getByText('logo.png')).toBeVisible()
  await card.getByRole('button', { name: 'Actions for logo.png' }).click()
  await page.getByRole('menuitem', { name: 'Edit caption' }).click()
  await card.getByRole('textbox', { name: 'Caption' }).fill('Main logo')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(card.getByText('Main logo')).toBeVisible()
  await card.getByRole('button', { name: 'Actions for logo.png' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('Nothing here yet')).toBeVisible()
})

test('a rejected file says why and can be retried or dismissed', async ({ page }) => {
  await page.goto('/media')
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('just text') })
  const job = page.getByTestId('upload-job')
  await expect(job).toContainText('Upload PNG, JPEG, WebP or SVG images')
  await expect(job.getByRole('button', { name: 'Try again' })).toBeVisible()
  await job.getByRole('button', { name: 'Dismiss' }).click()
  await expect(job).toHaveCount(0)
})

test('big files upload in parts and resume after a failed part', async ({ page }) => {
  await mock(page, 'mockFailPart')
  await page.goto('/media')
  const big = Buffer.alloc(5 * 1024 * 1024, 1)
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'clip.bin', mimeType: 'application/octet-stream', buffer: big })
  const job = page.getByTestId('upload-job')
  await expect(job).toContainText('Network hiccup.')
  await job.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('clip.bin')).toBeVisible()
  await expect(job).toHaveCount(0)
  // Two parts, one retried: the resume sent only the part that failed.
  expect(await page.evaluate<number>('window.__parts ?? 0')).toBe(3)
})

test('viewers browse the library but cannot upload', async ({ page }) => {
  await mock(page, 'mockRole', 'viewer')
  await page.goto('/media')
  await expect(page.getByText('Creators can upload logos, screenshots and clips here.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Upload' })).toHaveCount(0)
  await expect(page.getByTestId('media-dropzone')).toHaveCount(0)
})

test('media picked on New video goes to the plan and the video; chips lock while planning', async ({
  page,
}) => {
  await page.goto('/new')
  await page
    .getByLabel('What should the video show?')
    .fill('A 30-second launch video for org-wide webhooks, ending on our logo.')
  await page.getByRole('button', { name: 'Add media' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Nothing to pick yet.')).toBeVisible()
  await dialog.locator('input[type=file]').setInputFiles(pngFile())
  await dialog.getByTestId('pick-med_mock0001').click()
  await expect(dialog.getByText('1 of up to 12 picked')).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByTestId('chip-med_mock0001')).toContainText('logo.png')

  await page.getByRole('button', { name: 'Plan it first' }).click()
  await expect(page.getByText('Who is this video for?')).toBeVisible()
  expect(await page.evaluate("window.__sent['/api/v1/plans'].mediaIds")).toEqual(['med_mock0001'])
  await expect(page.getByRole('button', { name: 'Remove logo.png' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Remove logo.png' }).click()
  await expect(page.getByTestId('chip-med_mock0001')).toHaveCount(0)
  await page.getByRole('button', { name: 'Add media' }).click()
  await page.getByRole('dialog').getByTestId('pick-med_mock0001').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Create now' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  expect(await page.evaluate("window.__sent['/api/v1/videos'].mediaIds")).toEqual(['med_mock0001'])
})

test('a revision can add media', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByLabel('What should change?').fill('Put our logo on the end card')
  await page.getByRole('button', { name: 'Add media' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type=file]').setInputFiles(pngFile())
  await dialog.getByTestId('pick-med_mock0001').click()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: /Make v\d+ now/ }).click()
  await expect
    .poll(() => page.evaluate("window.__sent?.['/api/v1/videos/vid_teaser/versions']?.mediaIds"))
    .toEqual(['med_mock0001'])
})

test('a media slot is replaced from the library, filtered to its kind, with a fit', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  const logo = page.getByTestId('slot-logo')
  await expect(logo).toContainText('med_logo.svg')
  await logo.getByRole('button', { name: 'Replace Logo' }).click()
  const dialog = page.getByRole('dialog', { name: 'Replace Logo' })
  // An image slot offers images and SVGs only.
  await expect(dialog.getByRole('radio', { name: 'Clips' })).toHaveCount(0)
  await dialog.locator('input[type=file]').setInputFiles(pngFile('new-logo.png'))
  await dialog.getByTestId('pick-med_mock0001').click()
  await expect(dialog).toHaveCount(0)
  await expect(logo).toContainText('new-logo.png')
  await logo.getByText('Fill').click()
  await expect
    .poll(() => lastOps(page), { timeout: 5000 })
    .toEqual([
      { op: 'media', slot: 'logo', src: 'assets/media/med_mock0001.png', kind: 'image', fit: 'cover' },
    ])
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  // A clip slot opens the picker on clips.
  await page.getByTestId('slot-hero-clip').getByRole('button', { name: 'Replace Hero clip' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Replace Hero clip' }).getByText('Nothing to pick yet.'),
  ).toBeVisible()
})

// Client-side caching and code splitting.

/** Records the app's /api paths (window.__api) by wrapping whatever fetch the mock installs. */
const recordApi = (page: Page) =>
  page.addInitScript(() => {
    type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    const w = globalThis as unknown as { __api: string[]; fetch: Fetch; location: { href: string } }
    let inner = w.fetch
    w.__api = []
    Object.defineProperty(w, 'fetch', {
      configurable: true,
      get: (): Fetch => (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), w.location.href)
        if (url.pathname.startsWith('/api/')) w.__api.push(url.pathname)
        return inner(input, init)
      },
      set: (v: Fetch) => {
        inner = v
      },
    })
  })
const apiCalls = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __api: string[] }).__api.slice())

test('pages other than the library load on demand, as their own chunks', async ({ page, request }) => {
  const html = await (await request.get('/')).text()
  expect(html).not.toMatch(/Admin-[\w-]+\.js/)
  expect(html).not.toMatch(/Edit-[\w-]+\.js/)
  const chunks: string[] = []
  page.on('request', (r) => {
    if (/\/assets\/(Admin|Edit)-[\w-]+\.js$/.test(r.url())) chunks.push(r.url())
  })
  await page.goto('/admin')
  await expect(page.getByText('1 of 3 run slots in use', { exact: false })).toBeVisible()
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByRole('textbox', { name: 'Length of Opening' })).toBeVisible()
  expect(chunks.some((u) => u.includes('/Admin-'))).toBe(true)
  expect(chunks.some((u) => u.includes('/Edit-'))).toBe(true)
})

test('hovering a library tile prefetches the video, so opening it needs no new request', async ({ page }) => {
  await recordApi(page)
  await page.goto('/')
  // A video without unread comments: opening one with unread comments marks them read, which refetches it.
  const tile = page.locator('a.va-card', { hasText: 'Org webhooks launch' })
  await expect(tile).toBeVisible()
  await tile.hover()
  await expect.poll(() => apiCalls(page)).toContain('/api/v1/videos/vid_webhooks')
  const before = (await apiCalls(page)).length
  await tile.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Org webhooks launch' })).toBeVisible()
  const opened = (await apiCalls(page)).slice(before)
  expect(opened).not.toContain('/api/v1/videos/vid_webhooks')
  expect(opened).not.toContain('/api/v1/videos/vid_webhooks/comments')
  expect(opened).not.toContain('/api/v1/me')
  // Back in the library, the list is still fresh.
  await page.goBack()
  await expect(page.getByText('7 videos, 2 in progress.')).toBeVisible()
  expect((await apiCalls(page)).slice(before)).not.toContain('/api/v1/videos')
})

test('the media worker keeps signed version files by path and leaves everything else alone', async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'One browser profile is enough.')
  // The mock preview server answers /files like the edge and logs what reached it (vite.config.ts).
  const network = async (prefix: string) =>
    ((await (await request.get('/__files-log')).json()) as string[]).filter((u) => u.startsWith(prefix))
  await page.goto('/teaser-v2.jpg')
  // The page's worker and cache APIs (the specs aren't typechecked against the DOM library).
  interface Browser {
    navigator: {
      serviceWorker: {
        register(url: string, o: { scope: string }): Promise<unknown>
        ready: Promise<unknown>
        controller: unknown
      }
    }
    caches: { open(name: string): Promise<{ keys(): Promise<{ url: string }[]> }> }
  }
  await page.evaluate(async () => {
    const { serviceWorker } = (globalThis as unknown as Browser).navigator
    await serviceWorker.register('/sw.js', { scope: '/' })
    await serviceWorker.ready
  })
  await page.waitForFunction(
    () => (globalThis as unknown as Browser).navigator.serviceWorker.controller !== null,
  )
  const get = (path: string, headers: Record<string, string> = {}) =>
    page.evaluate(
      async ({ p, h }) => {
        const r = await fetch(p, { headers: h })
        return {
          status: r.status,
          range: r.headers.get('content-range'),
          size: (await r.arrayBuffer()).byteLength,
        }
      },
      { p: path, h: headers },
    )
  const cached = () =>
    page.evaluate(async () => {
      const cache = await (globalThis as unknown as Browser).caches.open('va-media-v1')
      return (await cache.keys()).map((r) => new URL(r.url).pathname).sort()
    })
  const id = `vid_e2e${Date.now().toString(36)}`
  const poster = `/files/${id}/v1/poster.jpg`
  // A refused signature isn't kept.
  expect((await get(`${poster}?exp=1&sig=bad`)).status).toBe(403)
  // The first good URL goes to the network; a later signature for the same file comes from the cache.
  expect(await get(`${poster}?exp=1&sig=a`)).toMatchObject({ status: 200, size: 12072 })
  await expect.poll(cached).toEqual([poster])
  expect(await get(`${poster}?exp=2&e=1&sig=b`)).toMatchObject({ status: 200, size: 12072 })
  expect(await network(poster)).toEqual([`${poster}?exp=1&sig=bad`, `${poster}?exp=1&sig=a`])
  // A clip's range request gets a 206 cut from the whole file, which is kept for the next range.
  const clip = `/files/${id}/v1/clip.mp4`
  expect(await get(`${clip}?exp=1&sig=a`, { range: 'bytes=10-19' })).toEqual({
    status: 206,
    range: 'bytes 10-19/12166',
    size: 10,
  })
  expect(await get(`${clip}?exp=3&sig=c`, { range: 'bytes=0-' })).toMatchObject({ status: 206, size: 12166 })
  expect(await network(clip)).toHaveLength(1)
  // The full video and unsigned URLs always go to the network, and aren't kept.
  const video = `/files/${id}/v1/video.mp4`
  await get(`${video}?exp=1&sig=a`)
  await get(`${video}?exp=2&sig=b`)
  await get(`/files/${id}/v1/preview.gif`)
  expect(await network(video)).toHaveLength(2)
  expect(await network(`/files/${id}/v1/preview.gif`)).toHaveLength(1)
  expect(await cached()).toEqual([clip, poster])
})
