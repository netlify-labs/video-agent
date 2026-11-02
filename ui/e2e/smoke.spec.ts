import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { MCP_TOOLS } from '../../src/mcp-catalog.js'

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

test('a run that needs music shows Finding music… before it starts', async ({ page }) => {
  await mock(page, 'mockMusic', 'searching')
  await page.goto('/videos/vid_making')
  await expect(page.getByTestId('stage-words')).toHaveText('Finding music…')
  await expect(page.getByRole('img', { name: 'Stage: Finding music' }).first()).toBeVisible()
  await expect(page.getByTestId('picked-music')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  await expect(page.getByText('Finding music…')).toHaveCount(2)
})

test('the track the server picked shows in the progress card and the details', async ({ page }) => {
  await mock(page, 'mockMusic', 'picked')
  await page.goto('/videos/vid_making')
  await expect(page.getByTestId('picked-music')).toHaveText('Music: Bright Horizons')
  await expect(page.getByText('Bright Horizons (picked from Openverse)')).toBeVisible()
})

test('a track from the library (Openverse found none in time) says so', async ({ page }) => {
  await mock(page, 'mockMusic', 'library')
  await page.goto('/videos/vid_making')
  await expect(page.getByTestId('picked-music')).toHaveText('Music: Quiet Lake (from your library)')
  await expect(page.getByText('Quiet Lake (from your library)', { exact: true })).toBeVisible()
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

/** Opens the navbar on phones (behind the burger); a no-op on desktop. */
async function openNav(page: Page) {
  const burger = page.getByRole('banner').getByRole('button', { name: 'Menu' })
  if (await burger.isVisible()) await burger.click()
}

const navbar = (page: Page) => page.locator('.mantine-AppShell-navbar')

test('/docs opens the REST reference, and the sidebar groups the three docs pages', async ({ page }) => {
  await page.goto('/docs')
  await expect(page).toHaveURL(/\/docs\/api$/)
  await expect(page.getByRole('heading', { level: 1, name: 'REST API' })).toBeVisible()
  await expect(page.getByText('Video Agent API').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('tab', { name: 'MCP for AI tools' })).toHaveCount(0)
  await openNav(page)
  const nav = navbar(page)
  await expect(nav.getByRole('button', { name: 'API docs' })).toHaveAttribute('aria-expanded', 'true')
  await expect(nav.getByRole('link', { name: 'REST API' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'MCP for AI tools' })).not.toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(nav.getByRole('link', { name: 'Agent skills' })).toBeVisible()
  await nav.getByRole('link', { name: 'MCP for AI tools' }).click()
  await expect(page).toHaveURL(/\/docs\/mcp$/)
  await expect(page.getByRole('heading', { level: 1, name: 'MCP for AI tools' })).toBeVisible()
  // On phones the navbar closes on navigation.
  if (test.info().project.name === 'phone') await expect(nav).not.toBeInViewport()
  await openNav(page)
  await expect(nav.getByRole('link', { name: 'MCP for AI tools' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'REST API' })).not.toHaveAttribute('aria-current', 'page')
})

test('the API docs group folds and opens from the keyboard, and stays shut elsewhere', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'Keyboard only.')
  await page.goto('/media')
  const group = navbar(page).getByRole('button', { name: 'API docs' })
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(navbar(page).getByRole('link', { name: 'REST API' })).toHaveCount(0)
  await group.focus()
  await page.keyboard.press('Enter')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Space')
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Space')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await expect(navbar(page).getByRole('link', { name: 'REST API' })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(navbar(page).getByRole('link', { name: 'REST API' })).toBeFocused()
})

test('old ?tab= links redirect to the docs pages, replacing the history entry', async ({ page }) => {
  await page.goto('/media')
  await page.goto('/docs?tab=mcp')
  await expect(page).toHaveURL(/\/docs\/mcp$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/media$/)
  await page.goto('/docs?tab=skills#install')
  await expect(page).toHaveURL(/\/docs\/skills#install$/)
})

test('the MCP page lists sections with MCP tools first, and the contents follow clicks and the hash', async ({
  page,
}) => {
  await page.goto('/docs/mcp')
  const toc = page.getByRole('navigation', { name: 'On this page' })
  await expect(toc.getByRole('link')).toHaveText([
    'MCP tools',
    'Connect',
    'Client setup',
    'Prompts',
    'Example asks',
  ])
  await expect(toc.getByRole('link', { name: 'MCP tools' })).toHaveAttribute('aria-current', 'location')
  const tools = page.getByRole('table', { name: 'MCP tools' })
  for (const t of MCP_TOOLS) await expect(tools.getByText(t.name, { exact: true })).toBeVisible()
  await expect(page.getByText('claude mcp add --transport http video-agent', { exact: false })).toBeVisible()
  await expect(page.getByText('claude_desktop_config.json', { exact: false })).toBeVisible()

  await toc.getByRole('link', { name: 'Client setup' }).click()
  await expect(page).toHaveURL(/\/docs\/mcp#clients$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Client setup' })).toBeInViewport()
  await expect(toc.getByRole('link', { name: 'Client setup' })).toHaveAttribute('aria-current', 'location')
  await expect(page.getByRole('heading', { level: 2, name: 'MCP tools' })).not.toBeInViewport()
})

test('a deep link opens the MCP page at its section', async ({ page }) => {
  await page.goto('/docs/mcp#connect')
  await expect(page.getByRole('heading', { level: 2, name: 'Connect' })).toBeInViewport()
  await expect(page.getByRole('textbox', { name: 'Server URL (Streamable HTTP)' })).toBeInViewport()
  const toc = page.getByRole('navigation', { name: 'On this page' })
  await expect(toc.getByRole('link', { name: 'Connect' })).toHaveAttribute('aria-current', 'location')
  expect(await page.evaluate<number>('window.scrollY')).toBeGreaterThan(0)
})

test('the MCP and skills pages do not load the API reference', async ({ page }) => {
  const scripts: string[] = []
  page.on('request', (r) => {
    if (r.resourceType() === 'script' || r.resourceType() === 'stylesheet') scripts.push(r.url())
  })
  await page.goto('/docs/mcp')
  await expect(page.getByRole('table', { name: 'MCP tools' })).toBeVisible()
  await page.goto('/docs/skills')
  await expect(page.getByRole('textbox', { name: 'Skill package (zip)', exact: true })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(scripts.some((u) => /McpGuide/.test(u))).toBe(true)
  expect(scripts.filter((u) => /ApiReference|Scalar/.test(u))).toEqual([])
  await page.goto('/docs/api')
  await expect(page.getByText('Video Agent API').first()).toBeVisible({ timeout: 15_000 })
  expect(scripts.some((u) => /ApiReference/.test(u))).toBe(true)
})

test('narrow screens get a row of section chips instead of the sticky contents', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/docs/mcp')
  await expect(page.locator('.va-docs-toc')).toBeHidden()
  const chips = page.locator('.va-docs-chips')
  await expect(chips).toBeVisible()
  await expect(chips.getByRole('link').first()).toHaveText('MCP tools')
  await chips.getByRole('link', { name: 'Prompts' }).click()
  await expect(page).toHaveURL(/#prompts$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Prompts' })).toBeInViewport()
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.locator('.va-docs-toc')).toBeVisible()
  await expect(chips).toBeHidden()
})

test('API docs show how to install the agent skill, with copy buttons', async ({ page }) => {
  await page.goto('/docs/skills')
  await expect(page.getByRole('heading', { level: 1, name: 'Agent skills' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'On this page' }).getByRole('link')).toHaveText([
    'Skill package',
    'Install',
    'The same recipes as MCP prompts',
  ])
  const origin = new URL(page.url()).origin
  await expect(page.getByRole('textbox', { name: 'Skill package (zip)', exact: true })).toHaveValue(
    `${origin}/skills/netlify-video.zip`,
  )
  await expect(page.getByRole('textbox', { name: 'Claude Code', exact: true })).toHaveValue(
    `curl -fsSL ${origin}/skills/netlify-video.zip -o /tmp/netlify-video.zip && unzip -o /tmp/netlify-video.zip -d ~/.claude/skills/`,
  )
  await expect(page.getByRole('textbox', { name: 'Codex', exact: true })).toHaveValue(
    /-d ~\/\.codex\/skills\/$/,
  )
  await expect(page.getByRole('button', { name: 'Copy Claude Code' })).toBeVisible()
  await expect(page.getByText('pr_video', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '/skills/index.json' })).toHaveAttribute(
    'href',
    '/skills/index.json',
  )
  await page.getByRole('link', { name: 'MCP for AI tools' }).last().click()
  await expect(page).toHaveURL(/\/docs\/mcp#connect$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Connect' })).toBeInViewport()
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

test('Sign in with Netlify: one button that returns here, and the rule in plain words', async ({ page }) => {
  await mock(page, 'mockAuthProvider', 'netlify')
  await mock(page, 'mockSignedOut')
  await page.goto('/videos/vid_1?tab=comments')
  const button = page.getByRole('link', { name: 'Sign in with Netlify' })
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute(
    'href',
    '/auth/netlify/start?return_to=%2Fvideos%2Fvid_1%3Ftab%3Dcomments',
  )
  await expect(
    page.getByText(
      'Use the Netlify account for your acme.com email address. You need to be a member of the acme Netlify team.',
    ),
  ).toBeVisible()
  await expect(page.getByLabel('Password')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Create account' })).toHaveCount(0)
})

test('a refused Netlify sign-in says why, once', async ({ page }) => {
  await mock(page, 'mockAuthProvider', 'netlify')
  await mock(page, 'mockSignedOut')
  await page.goto(`/?signin_error=${encodeURIComponent("You're not in the acme Netlify team.")}`)
  await expect(
    page.getByRole('alert').filter({ hasText: "You're not in the acme Netlify team." }),
  ).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
})

test('Identity keeps its email and password sign-in', async ({ page }) => {
  await mock(page, 'mockSignedOut')
  await page.goto('/')
  await expect(page.getByLabel('Password').first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in with Netlify' })).toHaveCount(0)
})

test('the People table shows how each person signs in', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.getByText('Netlify Identity · Sign in with Netlify')).toBeVisible()
})

test('keys page lists connected OAuth apps and revokes one', async ({ page }) => {
  await page.goto('/keys')
  const apps = page.getByRole('table', { name: 'Connected apps' })
  await expect(page.getByText('Sign in with Netlify')).toBeVisible()
  await expect(apps.getByRole('row')).toHaveCount(3)
  const claude = apps.getByRole('row', { name: /Claude/ })
  await expect(claude).toContainText('20 min ago')
  await expect(apps.getByRole('row', { name: /Cursor/ })).toContainText('Never')
  await claude.getByRole('button', { name: 'Revoke' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click()
  await expect(apps.getByRole('row', { name: /Claude/ })).toHaveCount(0)
  await expect(apps.getByRole('row')).toHaveCount(2)
})

test('keys page hides connected apps when MCP OAuth is off', async ({ page }) => {
  await mock(page, 'mockOAuth', '0')
  await page.goto('/keys')
  await expect(page.getByText('Release pipeline')).toBeVisible()
  await expect(page.getByText('Connected apps')).toHaveCount(0)
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

// Sound (idea 2): audio in the library, and the Sound choice on New video and Revise.
const mp3File = (name = 'theme.mp3') => ({
  name,
  mimeType: 'audio/mpeg',
  buffer: Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xf3, 0x70, 0xc0]),
})

test('the media library takes audio: an Audio filter and a player in the card', async ({ page }) => {
  await page.goto('/media')
  await expect(page.getByText(/MP3,\s+M4A, WAV or Ogg audio up to 50 MB/)).toBeVisible()
  await page.locator('input[type=file]').setInputFiles(pngFile())
  await page.locator('input[type=file]').setInputFiles(mp3File())
  const card = page.getByTestId('media-med_mock0002')
  await expect(card.getByText('theme.mp3')).toBeVisible()
  const player = card.getByTestId('player-med_mock0002')
  await expect(player).toHaveAttribute('src', '/tone.mp3')
  await expect(player).toHaveAttribute('controls', '')
  expect(await prop<boolean>(player, 'muted')).toBe(false)
  await expect(card.getByText('1:35')).toBeVisible()
  await page.getByText('Audio', { exact: true }).click()
  await expect(card).toBeVisible()
  await expect(page.getByTestId('media-med_mock0001')).toHaveCount(0)
  await page.getByText('Images', { exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('media-med_mock0001')).toBeVisible()
})

test('New video sends the Sound choice; picking a track turns music on', async ({ page }) => {
  await page.goto('/new')
  await page
    .getByLabel('What should the video show?')
    .fill('A 20-second launch video for our new feature, ending with "Try it today".')
  await expect(page.getByRole('radio', { name: 'Silent' })).toBeChecked()
  await page.getByRole('button', { name: 'Add media' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type=file]').setInputFiles(mp3File())
  await dialog.getByText('Audio', { exact: true }).click()
  await dialog.getByTestId('pick-med_mock0001').click()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByTestId('chip-med_mock0001')).toContainText('theme.mp3')
  await expect(page.getByRole('radio', { name: 'Music', exact: true })).toBeChecked()
  await expect(page.getByText('Music: theme.mp3.')).toBeVisible()
  await page.getByText('Music + effects', { exact: true }).click()
  await page.getByRole('button', { name: 'Create now' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  expect(await page.evaluate("window.__sent['/api/v1/videos'].sound")).toBe('music_sfx')
  expect(await page.evaluate("window.__sent['/api/v1/videos'].mediaIds")).toEqual(['med_mock0001'])
})

test('a revision keeps the sound unless changed, and sends a new choice', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByLabel('What should change?').fill('Warmer colours')
  await expect(page.getByRole('radio', { name: 'Silent' })).toBeChecked()
  await page.getByRole('button', { name: /Make v\d+ now/ }).click()
  await expect
    .poll(() => page.evaluate("window.__sent?.['/api/v1/videos/vid_teaser/versions']?.prompt"))
    .toBe('Warmer colours')
  expect(await page.evaluate("'sound' in window.__sent['/api/v1/videos/vid_teaser/versions']")).toBe(false)
  await page.getByLabel('What should change?').fill('Add a music bed')
  await page.getByText('Music', { exact: true }).click()
  await page.getByRole('button', { name: /Make v\d+ now/ }).click()
  await expect
    .poll(() => page.evaluate("window.__sent?.['/api/v1/videos/vid_teaser/versions']?.sound"))
    .toBe('music')
})

test('New video sends a voice-over with a voice, a pace and a script per beat', async ({ page }) => {
  await page.goto('/new')
  await page
    .getByLabel('What should the video show?')
    .fill('A 20-second launch video for our new feature, ending with "Try it today".')
  const voice = page.getByRole('switch', { name: /Voice-over/ })
  await expect(voice).not.toBeChecked()
  await expect(page.getByTestId('voiceover-options')).toHaveCount(0)
  await voice.click()
  await expect(page.getByTestId('voiceover-script')).toBeVisible()
  await page.getByLabel('Voice', { exact: true }).first().click()
  await page.getByRole('option', { name: /Michael/ }).click()
  await page.getByText('Faster', { exact: true }).click()
  await page.getByLabel('Line 1', { exact: true }).fill('Meet org webhooks.')
  await page.getByRole('button', { name: 'Add a line' }).click()
  await page.getByLabel('Line 2', { exact: true }).fill('One subscription for every project.')
  await page.getByRole('button', { name: 'Add a line' }).click()
  await page.getByRole('button', { name: 'Remove line 3' }).click()
  await expect(page.getByLabel('Line 3', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Create now' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  expect(await page.evaluate("window.__sent['/api/v1/videos'].voiceover")).toEqual({
    enabled: true,
    voice: 'am_michael',
    speed: 1.1,
    script: ['Meet org webhooks.', 'One subscription for every project.'],
  })
})

test('a video without a voice-over sends none', async ({ page }) => {
  await page.goto('/new')
  await page
    .getByLabel('What should the video show?')
    .fill('A 20-second launch video for our new feature, ending with "Try it today".')
  await page.getByRole('button', { name: 'Create now' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  expect(await page.evaluate("'voiceover' in window.__sent['/api/v1/videos']")).toBe(false)
})

test('Plan it first with a voice-over shows an editable narration per beat and creates with the plan', async ({
  page,
}) => {
  await page.goto('/new')
  await page
    .getByLabel('What should the video show?')
    .fill('A 30-second launch video for org-wide webhooks, ending on our logo.')
  await page.getByRole('switch', { name: /Voice-over/ }).click()
  await expect(page.getByText('Leave it empty and the plan writes the narration.')).toBeVisible()
  await page.getByRole('button', { name: 'Plan it first' }).click()
  await expect(page.getByText('Who is this video for?')).toBeVisible()
  expect(await page.evaluate("window.__sent['/api/v1/plans'].voiceover")).toEqual({ enabled: true })
  // The voice-over can't change under a plan in progress.
  await expect(page.getByRole('switch', { name: /Voice-over/ })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Skip' }).first().check()
  await page.getByRole('checkbox', { name: 'Skip' }).nth(1).check()
  await page.getByRole('button', { name: 'Done: write the brief' }).click()
  const first = page.getByLabel('Narration for beat 1')
  await expect(first).toHaveValue('Every project used to need its own webhook.')
  await expect(page.getByLabel('Narration for beat 3')).toHaveValue('Read the docs to set it up.')
  await first.fill('One webhook per project? Not anymore.')
  await page.getByRole('button', { name: 'Create video' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  expect(await page.evaluate("window.__sent['/api/v1/plans/plan_mock'].brief.beats[0].narration")).toBe(
    'One webhook per project? Not anymore.',
  )
  // The plan carries the voice-over and its narration; the create body doesn't repeat it.
  expect(await page.evaluate("window.__sent['/api/v1/videos'].planId")).toBe('plan_mock')
  expect(await page.evaluate("'voiceover' in window.__sent['/api/v1/videos']")).toBe(false)
})

test('a revision keeps the voice-over unless changed, and sends a new one', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByLabel('What should change?').fill('Warmer colours')
  const voice = page.getByRole('switch', { name: /Voice-over/ })
  await expect(voice).not.toBeChecked()
  // Opening the options and closing them again changes nothing.
  await voice.click()
  await page.getByRole('button', { name: 'Add a line' }).click()
  await voice.click()
  await page.getByRole('button', { name: /Make v\d+ now/ }).click()
  await expect
    .poll(() => page.evaluate("window.__sent?.['/api/v1/videos/vid_teaser/versions']?.prompt"))
    .toBe('Warmer colours')
  expect(await page.evaluate("'voiceover' in window.__sent['/api/v1/videos/vid_teaser/versions']")).toBe(
    false,
  )
  await page.getByLabel('What should change?').fill('Add a narrator')
  await page.getByRole('switch', { name: /Voice-over/ }).click()
  await page.getByLabel('Line 1', { exact: true }).fill('Preview every change.')
  await page.getByRole('button', { name: /Make v\d+ now/ }).click()
  await expect
    .poll(() => page.evaluate("window.__sent?.['/api/v1/videos/vid_teaser/versions']?.voiceover"))
    .toEqual({ enabled: true, script: ['Preview every change.'] })
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

test('the Audio card shows only with music; Replace is filtered to audio; volume and mute save audio ops', async ({
  page,
}) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('beat-intro')).toBeVisible()
  await expect(page.getByTestId('audio-card')).toHaveCount(0)

  await mock(page, 'mockMusic')
  await page.goto('/videos/vid_teaser/edit/2')
  const row = page.getByTestId('audio-music')
  // The track's library name, not its id.
  await expect(row).toContainText('Music')
  await expect(row).toContainText('Upbeat theme.mp3')
  await expect(page.getByTestId('audio-card')).toContainText('80%')

  // Two steps down on the keyboard: 80% to 70%.
  await row.getByRole('slider', { name: 'Volume of Music' }).focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('audio-card')).toContainText('70%')
  await expect
    .poll(() => lastOps(page), { timeout: 5000 })
    .toEqual([{ op: 'audio', id: 'music', volume: 0.7 }])
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')

  await row.getByRole('button', { name: 'Mute Music' }).click()
  await expect(row.getByRole('button', { name: 'Mute Music' })).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => lastOps(page), { timeout: 5000 })
    .toEqual([{ op: 'audio', id: 'music', volume: 0.7, muted: true }])
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')

  await row.getByRole('button', { name: 'Replace Music' }).click()
  const dialog = page.getByRole('dialog', { name: 'Replace Music' })
  // Audio only: no images or clips to pick.
  await expect(dialog.getByTestId('pick-med_theme01')).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'Images' })).toHaveCount(0)
  await expect(dialog.getByRole('radio', { name: 'Clips' })).toHaveCount(0)
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'calm.mp3',
    mimeType: 'audio/mpeg',
    buffer: readFileSync(new URL('../../test/fixtures/audio/tone.mp3', import.meta.url)),
  })
  await dialog.getByTestId('pick-med_mock0002').click()
  await expect(dialog).toHaveCount(0)
  await expect(row).toContainText('calm.mp3')
  await expect
    .poll(() => lastOps(page), { timeout: 5000 })
    .toEqual([{ op: 'audio', id: 'music', src: 'assets/media/med_mock0002.mp3', volume: 0.7, muted: true }])
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
})

test('the Voice section lists each voiced line; a changed line is marked for re-voicing and saves a voice op', async ({
  page,
}) => {
  // Without a voice-over there is no Voice section.
  await mock(page, 'mockMusic')
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('audio-music')).toBeVisible()
  await expect(page.getByTestId('voice-section')).toHaveCount(0)

  await mock(page, 'mockVoice')
  await page.goto('/videos/vid_teaser/edit/2')
  const section = page.getByTestId('voice-section')
  await expect(page.getByTestId('audio-music')).toBeVisible()
  await expect(section.getByTestId('voice-intro')).toContainText('Opening')
  await expect(section.getByRole('textbox', { name: 'Narration for Opening' })).toHaveValue(
    'Meet org webhooks. One place for every event.',
  )
  await expect(section.getByRole('textbox', { name: 'Narration for Outro' })).toHaveValue('Read the docs.')
  await expect(section.getByText('Re-voice on render')).toHaveCount(0)

  const outro = section.getByRole('textbox', { name: 'Narration for Outro' })
  await outro.fill('Read the docs today.')
  await expect(section.getByTestId('voice-outro')).toContainText('Re-voice on render')
  await expect
    .poll(() => lastOps(page), { timeout: 5000 })
    .toEqual([{ op: 'voice', beat: 'outro', text: 'Read the docs today.' }])
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')

  // Back to the spoken words: no op, nothing to re-voice.
  await outro.fill('Read the docs.')
  await expect(section.getByText('Re-voice on render')).toHaveCount(0)
  await expect.poll(() => lastOps(page), { timeout: 5000 }).toEqual([])
})

test('the preview frame may play sound once the person presses play', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('composition-preview')).toHaveAttribute('allow', 'autoplay')
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

test('voice previews play a sample, one at a time, without picking the voice', async ({ page }) => {
  await page.goto('/new')
  await page.getByTestId('voiceover-switch').check()
  const samples: string[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('.mp3')) samples.push(r.url())
  })
  // The button beside the select plays the chosen voice (the default is Heart).
  await page.getByRole('button', { name: 'Hear Heart' }).click()
  await expect(page.getByRole('button', { name: 'Stop Heart' })).toBeVisible()
  await expect.poll(() => samples.some((u) => /af_heart.*\.mp3$/.test(u))).toBe(true)
  await page.getByRole('button', { name: 'Stop Heart' }).click()
  await expect(page.getByRole('button', { name: 'Hear Heart' })).toBeVisible()
  // In the list, a preview plays that voice and leaves the choice alone.
  await page.getByRole('combobox', { name: 'Voice' }).click()
  await page.getByTestId('voice-preview-am_michael').click()
  await expect.poll(() => samples.some((u) => /am_michael.*\.mp3$/.test(u))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveValue('Default (Heart)')
})

// Openverse (Find music): search through the mock API, preview, import into the library, and the credit line.
const MORNING = '00000001-0000-4000-8000-000000000001'
const HARBOR = '00000002-0000-4000-8000-000000000002'

test('Find music searches Openverse, previews a track, and imports it into the library', async ({ page }) => {
  await page.goto('/media')
  await page.getByRole('button', { name: 'Find music' }).click()
  const dialog = page.getByRole('dialog', { name: 'Find music on Openverse' })
  await dialog.getByLabel('Search music').fill('piano music')
  await dialog.getByRole('button', { name: 'Search' }).click()
  const row = dialog.getByTestId(`track-${MORNING}`)
  await expect(row).toContainText('Morning Light')
  await expect(row).toContainText('Lena Park · 2:34')
  await expect(row.getByText('CC BY 4.0')).toBeVisible()
  await expect(dialog.getByTestId(`track-${HARBOR}`).getByText('CC0 1.0')).toBeVisible()

  // One preview at a time; pressing again stops it.
  const play = dialog.getByTestId(`preview-${MORNING}`)
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'true')
  await expect(play).toHaveAccessibleName('Stop Morning Light')
  await dialog.getByTestId(`preview-${HARBOR}`).click()
  await expect(play).toHaveAttribute('aria-pressed', 'false')
  await expect(dialog.getByTestId(`preview-${HARBOR}`)).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByTestId(`preview-${HARBOR}`).click()
  await expect(dialog.getByTestId(`preview-${HARBOR}`)).toHaveAttribute('aria-pressed', 'false')

  // CC0 only hides the CC BY tracks.
  await dialog.getByText('CC0 only', { exact: true }).click()
  await expect(dialog.getByTestId(`track-${MORNING}`)).toHaveCount(0)
  await expect(dialog.getByTestId(`track-${HARBOR}`)).toBeVisible()
  await dialog.getByText('CC0 + CC BY', { exact: true }).click()

  await row.getByRole('button', { name: 'Import' }).click()
  await expect(row.getByText('In library')).toBeVisible()
  await page.keyboard.press('Escape')
  const card = page.getByTestId('media-med_mock0001')
  await expect(card.getByText('Morning Light - Lena Park.mp3')).toBeVisible()
  const source = card.getByTestId('media-source')
  await expect(source.getByText('CC BY 4.0')).toBeVisible()
  await expect(source.getByRole('link', { name: 'Lena Park' })).toHaveAttribute(
    'href',
    'https://www.jamendo.com/artist/1001',
  )
  await expect(source.getByRole('link', { name: 'Openverse' })).toHaveAttribute(
    'href',
    'https://www.jamendo.com/track/2001',
  )
})

test('a track imported from the picker is picked straight away', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('button', { name: 'Add media' }).click()
  const picker = page.getByRole('dialog', { name: 'Add media' })
  await picker.getByRole('button', { name: 'Find music' }).click()
  const find = page.getByRole('dialog', { name: 'Find music on Openverse' })
  await find.getByLabel('Search music').fill('music')
  await find.getByRole('button', { name: 'Search' }).click()
  await find.getByTestId(`track-${HARBOR}`).getByRole('button', { name: 'Import' }).click()
  await expect(find).toHaveCount(0)
  await expect(picker.getByTestId('pick-med_mock0001')).toHaveAttribute('aria-pressed', 'true')
  await picker.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByTestId('chip-med_mock0001')).toContainText('Quiet Harbor')
})

test('a busy Openverse says so', async ({ page }) => {
  await mock(page, 'mockOpenverseBusy')
  await page.goto('/media')
  await page.getByRole('button', { name: 'Find music' }).click()
  const dialog = page.getByRole('dialog', { name: 'Find music on Openverse' })
  await dialog.getByLabel('Search music').fill('calm')
  await dialog.getByRole('button', { name: 'Search' }).click()
  await expect(dialog.getByTestId('openverse-error')).toHaveText('Openverse is busy, try again in a minute.')
})

test('a slow Openverse search shows a spinner, then the results; a slow import shows Importing…', async ({
  page,
}) => {
  await mock(page, 'mockOpenverseSlow')
  await page.goto('/media')
  await page.getByRole('button', { name: 'Find music' }).click()
  const dialog = page.getByRole('dialog', { name: 'Find music on Openverse' })
  await dialog.getByLabel('Search music').fill('piano music')
  await dialog.getByRole('button', { name: 'Search' }).click()
  await expect(dialog.getByTestId('openverse-searching')).toContainText('Searching Openverse…')
  await expect(dialog.getByTestId('openverse-searching')).toContainText('slow right now')
  const row = dialog.getByTestId(`track-${MORNING}`)
  await expect(row).toContainText('Morning Light')
  await expect(dialog.getByTestId('openverse-searching')).toHaveCount(0)

  await row.getByRole('button', { name: 'Import' }).click()
  await expect(row.getByRole('button', { name: 'Importing…' })).toBeDisabled()
  await expect(row.getByText('In library')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page.getByTestId('media-med_mock0001').getByText('Morning Light - Lena Park.mp3'),
  ).toBeVisible()
})

test('a search Openverse never finishes gives up after two minutes and offers Retry', async ({ page }) => {
  await page.clock.install()
  await mock(page, 'mockOpenverseSlow', 'stuck')
  await page.goto('/media')
  await page.getByRole('button', { name: 'Find music' }).click()
  const dialog = page.getByRole('dialog', { name: 'Find music on Openverse' })
  await dialog.getByLabel('Search music').fill('music')
  await dialog.getByRole('button', { name: 'Search' }).click()
  // The server handed the search to a job; two minutes pass without it finishing.
  await expect(dialog.getByTestId('openverse-searching')).toContainText('slow right now')
  await page.clock.fastForward('02:05')
  await expect(dialog.getByTestId('openverse-error')).toHaveText(
    'Openverse is taking too long to answer. Try again in a minute.',
  )
  // Openverse recovers: Retry searches again and shows the tracks.
  await page.evaluate(() => {
    localStorage.setItem('mockOpenverseSlow', '1')
  })
  await dialog.getByRole('button', { name: 'Retry' }).click()
  await expect(dialog.getByTestId('openverse-searching')).toBeVisible()
  await expect(dialog.getByTestId(`track-${HARBOR}`)).toContainText('Quiet Harbor')
})

test('viewers get no Find music button', async ({ page }) => {
  await mock(page, 'mockRole', 'viewer')
  await page.goto('/media')
  await expect(page.getByRole('heading', { level: 1, name: 'Media' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Find music' })).toHaveCount(0)
})

test('a version with a CC BY track credits it on the page and in the embed', async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  const credits = page.getByTestId('version-credits')
  await expect(credits).toContainText('Music: Morning Light by Lena Park, CC BY 4.0')
  await expect(credits.getByRole('link', { name: 'Morning Light' })).toHaveAttribute(
    'href',
    'https://www.jamendo.com/track/2002',
  )
  await expect(credits.getByRole('link', { name: 'CC BY 4.0' })).toHaveAttribute(
    'href',
    'https://creativecommons.org/licenses/by/4.0/',
  )
  await expect(page.getByRole('textbox', { name: 'Embed' })).toHaveValue(
    /<figcaption[^>]*>Music: <a href="https:\/\/www\.jamendo\.com\/track\/2002"/,
  )
  // Versions without one show no credits.
  await page.goto('/videos/vid_teaser')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Ship faster with preview deploys' }),
  ).toBeVisible()
  await expect(page.getByTestId('version-credits')).toHaveCount(0)
})

/** A Notification API whose permission the test sets (headless browsers differ on the default). */
const stubNotifications = (page: import('@playwright/test').Page, permission: 'default' | 'denied') =>
  page.addInitScript((initial) => {
    let current: string = initial
    const FakeNotification = {
      get permission() {
        return current
      },
      requestPermission() {
        if (current === 'default') current = 'granted'
        return Promise.resolve(current)
      },
    }
    Object.defineProperty(globalThis, 'Notification', { value: FakeNotification, configurable: true })
  }, permission)

test('while a video renders: a clear Notify button and a link to the agent run', async ({ page }) => {
  await stubNotifications(page, 'default')
  await page.goto('/videos/vid_making')
  const notify = page.getByTestId('notify-toggle')
  await expect(notify).toHaveText("Notify me when it's done")
  await expect(notify).toHaveAttribute('aria-pressed', 'false')
  await notify.click()
  await expect(notify).toHaveText("You'll be notified")
  await expect(notify).toHaveAttribute('aria-pressed', 'true')
  await notify.click()
  await expect(notify).toHaveText("Notify me when it's done")
  const run = page.getByTestId('progress-run-link')
  await expect(run).toHaveText(/View agent run/)
  await expect(run).toHaveAttribute('href', /app\.netlify\.com\/projects\/.+\/agent-runs\//)
  await expect(run).toHaveAttribute('target', '_blank')
})

test('the Notify button says when the browser blocks notifications', async ({ page }) => {
  await stubNotifications(page, 'denied')
  await page.goto('/videos/vid_making')
  await expect(page.getByTestId('notify-toggle')).toHaveText('Notifications blocked')
})

test('Find music lists other places to find music, each opening in a new tab', async ({ page }) => {
  await page.goto('/media')
  await page.getByRole('button', { name: 'Find music' }).click()
  const dialog = page.getByRole('dialog', { name: /Find music/ })
  const sources = dialog.getByTestId('music-sources')
  await sources.getByText('More places to find music').click()
  const links = sources.getByRole('link')
  await expect(links).toHaveCount(10)
  await expect(sources.getByRole('link', { name: 'Pixabay Music' })).toHaveAttribute(
    'href',
    'https://pixabay.com/music/',
  )
  await expect(sources.getByRole('link', { name: 'YouTube Audio Library' })).toBeVisible()
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
  }
})
