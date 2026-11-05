// Looks in the web app (plan 2026-11-04-looks §6, beads va-nifa.4.1 and 4.2): the mock's looks routes and the New video
// picker. Previews cost bandwidth, so the picker loads posters only until a card is hovered or focused.
import { expect, test, type Page } from '@playwright/test'

/** Sets a mock API switch in localStorage before the app loads. */
const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })

/** The look clips the page fetched (the mock bundles looks/<id>/preview.mp4 under /assets/). */
function clips(page: Page) {
  const urls: string[] = []
  page.on('request', (r) => {
    if (/\/assets\/preview-[\w-]+\.mp4/.test(r.url())) urls.push(r.url())
  })
  return urls
}

const sent = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __sent?: Record<string, Record<string, unknown>> }).__sent?.['/api/v1/videos'],
  )

async function createNow(page: Page) {
  await page
    .getByLabel('What should the video show?')
    .fill('A launch video for org webhooks, with an end card.')
  await page.getByRole('button', { name: 'Create video' }).click()
  await page.getByRole('button', { name: /Create it now/ }).click()
  await expect.poll(() => sent(page)).toBeTruthy()
  return (await sent(page)) as Record<string, unknown>
}

const card = (page: Page, id: string) => page.locator(`.va-look-pick[data-look="${id}"]`)

test('the mock answers GET /api/v1/looks and lists looks in the config', async ({ page }) => {
  await page.goto('/')
  const body = await page.evaluate(async () => {
    const [looks, config] = await Promise.all([fetch('/api/v1/looks'), fetch('/api/v1/config')])
    return {
      looks: (await looks.json()) as { looks: { id: string; enabled: boolean }[]; default: null },
      config: (await config.json()) as { features: string[] },
    }
  })
  expect(body.looks.looks.map((l) => l.id)).toEqual(['clean', 'kinetic', 'terminal'])
  expect(body.looks.default).toBeNull()
  expect(body.config.features).toContain('looks')
})

test('the picker shows posters only until a card is hovered or focused', async ({ page, isMobile }) => {
  const urls = clips(page)
  await page.goto('/new')
  // A tap on a phone: a mouse click would leave the pointer resting over a card of the full-screen picker.
  const open = page.getByRole('button', { name: 'Look: None' })
  await (isMobile ? open.tap() : open.click())
  const dialog = page.getByRole('dialog', { name: 'Pick a look' })
  await expect(dialog.locator('.va-look-pick')).toHaveCount(4)
  await expect(dialog.locator('img')).toHaveCount(3)
  await expect(dialog.locator('video')).toHaveCount(0)
  expect(urls).toEqual([])

  if (!isMobile) {
    await card(page, 'kinetic').hover()
    await expect(dialog.locator('video')).toHaveCount(1)
    await expect.poll(() => urls.length).toBeGreaterThan(0)
    await expect(dialog.locator('video')).toHaveAttribute('preload', 'none')
    expect(
      await dialog.locator('video').evaluate((v: { muted: boolean; loop: boolean }) => [v.muted, v.loop]),
    ).toEqual([true, true])
    await page.mouse.move(0, 0)
    await expect(dialog.locator('video')).toHaveCount(0)
  }
  await card(page, 'terminal').focus()
  await expect(card(page, 'terminal').locator('video')).toHaveCount(1)
})

test('with reduced motion a card shows its poster and a play button', async ({ page, isMobile }) => {
  test.skip(isMobile, 'hover')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const urls = clips(page)
  await page.goto('/new')
  await page.getByRole('button', { name: 'Look: None' }).click()
  await card(page, 'kinetic').hover()
  await card(page, 'clean').focus()
  await expect(page.locator('.va-look-grid video')).toHaveCount(0)
  expect(urls).toEqual([])
  await page.getByRole('button', { name: 'Play the Kinetic type preview' }).click()
  await expect(page.locator('.va-look-grid video')).toHaveCount(1)
})

test('picks with the keyboard, and the create request carries the look', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('button', { name: 'Look: None' }).click()
  await card(page, 'none').focus()
  await page.keyboard.press('ArrowRight')
  await expect(card(page, 'clean')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(card(page, 'kinetic')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Pick a look' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Look: Clean product' })).toBeVisible()
  expect((await createNow(page)).look).toBe('clean')
})

test('Escape closes the picker without a change; untouched leaves look out', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('button', { name: 'Look: None' }).click()
  await card(page, 'clean').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Pick a look' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Look: None' })).toBeVisible()
  expect(await createNow(page)).not.toHaveProperty('look')
})

test('None sends look: null over the admin default; disabled looks are hidden', async ({ page }) => {
  await mock(page, 'mockLookDefault', 'kinetic')
  await mock(page, 'mockLooksDisabled', 'terminal')
  await page.goto('/new')
  await page.getByRole('button', { name: 'Look: Kinetic type' }).click()
  await expect(card(page, 'kinetic')).toHaveAttribute('aria-pressed', 'true')
  await expect(card(page, 'terminal')).toHaveCount(0)
  await card(page, 'none').click()
  await expect(page.getByRole('button', { name: 'Look: None' })).toBeVisible()
  expect((await createNow(page)).look).toBeNull()
})

test('a deployment without looks shows no Look control', async ({ page }) => {
  await mock(page, 'mockNoLooks')
  await page.goto('/new')
  await expect(page.getByRole('button', { name: 'Create video' })).toBeVisible()
  await expect(page.getByTestId('look-control')).toHaveCount(0)
})
