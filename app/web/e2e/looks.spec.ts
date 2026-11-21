// Looks in the web app (plan 2026-11-04-looks §6, beads va-nifa.4.1 and 4.2): the mock's looks routes and the New video
// picker. Previews cost bandwidth, so the picker loads posters only until a card is hovered or focused.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { looksCatalog } from '../../server/generated/looks.js'

/** The catalog the mock serves (every look in app/looks/). */
const IDS = looksCatalog.map((l) => l.id)

/** Sets a mock API switch in localStorage before the app loads. */
const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })

/** The look clips the page fetched (the mock bundles app/looks/<id>/preview.mp4 under /assets/). */
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
      (globalThis as unknown as { __sent?: Record<string, Record<string, unknown>> }).__sent?.[
        '/api/v1/videos'
      ],
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
  // The mock API is installed before the app's first request: wait for the app.
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
  const body = await page.evaluate(async () => {
    const [looks, config] = await Promise.all([fetch('/api/v1/looks'), fetch('/api/v1/config')])
    return {
      looks: (await looks.json()) as { looks: { id: string; enabled: boolean }[]; default: null },
      config: (await config.json()) as { features: string[] },
    }
  })
  expect(body.looks.looks.map((l) => l.id)).toEqual(IDS)
  expect(body.looks.default).toBeNull()
  expect(body.config.features).toContain('looks')
})

test('the picker shows posters only until a card is hovered or focused', async ({ page, isMobile }) => {
  const urls = clips(page)
  await page.goto('/new')
  // A tap on a phone, the keyboard elsewhere: a mouse click would leave the pointer resting over a card of the
  // picker, which is a hover that plays its clip.
  const open = page.getByRole('button', { name: 'Look: Agent decides' })
  if (isMobile) await open.tap()
  else {
    await open.focus()
    await page.keyboard.press('Enter')
  }
  const dialog = page.getByRole('dialog', { name: 'Pick a look' })
  await expect(dialog.locator('.va-look-pick')).toHaveCount(IDS.length + 1)
  await expect(dialog.locator('img')).toHaveCount(IDS.length)
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
  await page.getByRole('button', { name: 'Look: Agent decides' }).click()
  await card(page, 'kinetic').hover()
  await card(page, 'clean').focus()
  await expect(page.locator('.va-look-grid video')).toHaveCount(0)
  expect(urls).toEqual([])
  await page.getByRole('button', { name: 'Play the Kinetic type preview' }).click()
  await expect(page.locator('.va-look-grid video')).toHaveCount(1)
})

test('picks with the keyboard, and the create request carries the look', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('button', { name: 'Look: Agent decides' }).click()
  await card(page, 'none').focus()
  const [first, second] = looksCatalog
  await page.keyboard.press('ArrowRight')
  await expect(card(page, first!.id)).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(card(page, second!.id)).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Pick a look' })).toBeHidden()
  await expect(page.getByRole('button', { name: `Look: ${first!.name}` })).toBeVisible()
  expect((await createNow(page)).look).toBe(first!.id)
})

test('Escape closes the picker without a change; untouched leaves look out', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('button', { name: 'Look: Agent decides' }).click()
  await card(page, 'clean').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Pick a look' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Look: Agent decides' })).toBeVisible()
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
  await expect(page.getByRole('button', { name: 'Look: Agent decides' })).toBeVisible()
  expect((await createNow(page)).look).toBeNull()
})

test('a deployment without looks shows no Look control', async ({ page }) => {
  await mock(page, 'mockNoLooks')
  await page.goto('/new')
  await expect(page.getByRole('button', { name: 'Create video' })).toBeVisible()
  await expect(page.getByTestId('look-control')).toHaveCount(0)
})

// Video page: the Look detail and Restyle (bead va-nifa.4.3). vid_webhooks v1 was made in the kinetic look.

/** Restyle sits with the actions above the player, or in More actions on a phone. */
async function openRestyle(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Restyle…' }).click()
  } else await page.getByRole('button', { name: 'Restyle v1' }).click()
}

/**
 * Presses a button low in a full-screen dialog. On the phone project the video page is wider than the screen (its
 * header, before looks), the browser zooms out, and a pointer click there lands beside the button; Enter doesn't.
 */
async function press(button: Locator) {
  await button.focus()
  await button.press('Enter')
}

const lastRevise = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __lastRevise?: Record<string, unknown> }).__lastRevise)

test('the details show the look, and Restyle sends a revision with the look and the text', async ({
  page,
  isMobile,
}) => {
  await page.goto('/videos/vid_webhooks')
  await expect(page.locator('.va-fact', { hasText: 'Look' })).toContainText('Kinetic type')
  await openRestyle(page, isMobile)
  const dialog = page.getByRole('dialog', { name: 'Restyle v1' })
  await expect(dialog.getByTestId('restyle-cost')).toHaveText(
    'This makes a new version (a full run). v1 took 206 credits.',
  )
  // The version's own look at the same hash isn't a restyle.
  await expect(card(page, 'kinetic')).toBeDisabled()
  await expect(card(page, 'kinetic')).toContainText('Current')
  await expect(dialog.getByRole('button', { name: 'Make v2' })).toBeDisabled()
  await card(page, 'terminal').click()
  await expect(dialog.getByLabel('Anything else?')).toHaveValue('Restyle this video in the Terminal look.')
  await dialog
    .getByLabel('Anything else?')
    .fill('Restyle this video in the Terminal look. Keep the end card.')
  await press(dialog.getByRole('button', { name: 'Make v2' }))
  await expect(dialog).toBeHidden()
  expect(await lastRevise(page)).toEqual({
    prompt: 'Restyle this video in the Terminal look. Keep the end card.',
    fromVersion: 1,
    look: 'terminal',
  })
})

test('Restyle into the same look once the catalog has a newer version of it', async ({ page, isMobile }) => {
  await mock(page, 'mockLookUpdated', 'kinetic')
  await page.goto('/videos/vid_webhooks')
  await openRestyle(page, isMobile)
  await expect(card(page, 'kinetic')).toBeEnabled()
  await expect(card(page, 'kinetic')).toContainText('Updated')
  await card(page, 'kinetic').click()
  await press(page.getByRole('dialog', { name: 'Restyle v1' }).getByRole('button', { name: 'Make v2' }))
  await expect.poll(() => lastRevise(page)).toMatchObject({ look: 'kinetic' })
})

test('Restyle is hidden for recorded narration and for reviewers; a stale refusal shows inline', async ({
  page,
  isMobile,
}) => {
  await page.goto('/videos/vid_sales')
  await expect(page.getByRole('heading', { level: 1, name: /Deploy previews/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restyle v1' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Restyle…' })).toHaveCount(0)

  // A page that loaded before the narration landed: the server refuses with 409, shown in the dialog.
  await page.goto('/videos/vid_webhooks')
  await openRestyle(page, isMobile)
  await page.evaluate(() => {
    const w = globalThis as unknown as { fetch: typeof fetch }
    const inner = w.fetch
    w.fetch = (input, init) =>
      String(input instanceof Request ? input.url : input).endsWith('/versions')
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'look_not_allowed',
                  message: "Restyle isn't available for videos with recorded narration yet.",
                },
              }),
              { status: 409, headers: { 'content-type': 'application/json' } },
            ),
          )
        : inner(input, init)
  })
  await card(page, 'clean').click()
  await press(page.getByRole('dialog', { name: 'Restyle v1' }).getByRole('button', { name: 'Make v2' }))
  await expect(page.getByTestId('restyle-error')).toContainText(
    "Restyle isn't available for videos with recorded narration yet.",
  )

  await mock(page, 'mockRole', 'reviewer')
  await page.goto('/videos/vid_webhooks')
  await expect(page.getByRole('heading', { level: 1, name: 'Org webhooks launch' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restyle v1' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Restyle…' })).toHaveCount(0)
})

// Remix: a Look control defaulting to the source's look (bead va-nifa.4.4).

const lastRemix = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __lastRemix?: Record<string, unknown> }).__lastRemix)

test("Remix shows the source's look, leaves it out unchanged and sends a change", async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  await page.getByRole('button', { name: 'Remix', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Remix Org webhooks launch v1/ })
  await expect(dialog.getByRole('button', { name: 'Look: Kinetic type' })).toBeVisible()
  await dialog.getByLabel('What would you change?').fill('Same story for the payments team')
  await dialog.getByRole('button', { name: 'Remix', exact: true }).click()
  await expect.poll(() => lastRemix(page)).toBeTruthy()
  expect(await lastRemix(page)).not.toHaveProperty('look')

  await page.goto('/videos/vid_webhooks')
  await page.getByRole('button', { name: 'Remix', exact: true }).click()
  const again = page.getByRole('dialog', { name: /Remix Org webhooks launch v1/ })
  await again.getByRole('button', { name: 'Look: Kinetic type' }).click()
  await card(page, 'none').click()
  await expect(again.getByRole('button', { name: 'Look: Agent decides' })).toBeVisible()
  await again.getByLabel('What would you change?').fill('Same story, no look')
  await again.getByRole('button', { name: 'Remix', exact: true }).click()
  await expect.poll(() => lastRemix(page)).toMatchObject({ look: null })
})

// Admin: the Looks section (bead va-nifa.4.5). The mock keeps settings in memory, so the test moves within the app.

test('an admin turns a look off and it leaves the picker; a disabled default is refused inline', async ({
  page,
}) => {
  await page.goto('/admin')
  const looks = page.getByTestId('looks-settings')
  const terminal = looks.getByRole('switch', { name: 'Terminal look' })
  await terminal.evaluate("(el) => el.scrollIntoView({ block: 'center' })")
  await terminal.click()
  await expect(looks.getByRole('switch', { name: 'Terminal look' })).not.toBeChecked()

  // A default that's turned off is refused, and the card says why.
  await looks.getByLabel('Default for new videos').click()
  await page.getByRole('option', { name: 'Terminal' }).click()
  await expect(looks.getByTestId('looks-settings-error')).toContainText('turned off')
  await looks.getByLabel('Default for new videos').click()
  await page.getByRole('option', { name: 'Kinetic type' }).click()
  await expect(looks.getByLabel('Default for new videos')).toHaveValue('Kinetic type')

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      history: { pushState: (a: null, b: string, c: string) => void }
      dispatchEvent: (e: unknown) => void
      PopStateEvent: new (t: string) => unknown
    }
    w.history.pushState(null, '', '/new')
    w.dispatchEvent(new w.PopStateEvent('popstate'))
  })
  await page.getByRole('button', { name: 'Look: Kinetic type' }).click()
  await expect(card(page, 'terminal')).toHaveCount(0)
  await expect(card(page, 'clean')).toBeVisible()
})

// Docs: /docs/looks lists every catalog look (bead va-nifa.4.8).

test('/docs/looks renders every catalog look and is in the docs nav', async ({ page }) => {
  await page.goto('/docs/looks')
  await expect(page.getByRole('heading', { level: 1, name: 'Looks' })).toBeVisible()
  const catalog = page.getByTestId('looks-catalog')
  await expect(catalog.locator('[data-look]')).toHaveCount(IDS.length)
  for (const name of looksCatalog.map((l) => l.name))
    await expect(catalog.getByText(name, { exact: false }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Looks', exact: true }).first()).toHaveAttribute(
    'href',
    '/docs/looks',
  )
})

// The brief's look chip (bead va-nifa.4.7): the plan picks a look for its template; changing it changes the create.

async function planToBrief(page: Page) {
  await page.goto('/new')
  await page
    .getByLabel('What should the video show?')
    .fill('A 30-second launch video for org-wide webhooks, ending on our logo.')
  await page.getByRole('button', { name: 'Create video', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Plan it first/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Plan your video' })
  await expect(dialog.getByText('Who is this video for?')).toBeVisible()
  await dialog.getByRole('button', { name: 'Next' }).click()
  await dialog.getByRole('button', { name: 'Write the brief' }).click()
  await expect(dialog.getByLabel('Call to action')).toBeVisible()
  return dialog
}

test("the brief shows the plan's look, and changing it sends the new look on create", async ({ page }) => {
  // The mock's plans are launches: the first enabled look made for one.
  const fit = looksCatalog.find((l) => (l.bestFor as string[]).includes('launch'))!
  const other = looksCatalog.find((l) => l.id !== fit.id)!
  const dialog = await planToBrief(page)
  const chip = dialog.getByTestId('plan-look')
  await expect(chip.getByRole('button', { name: `Look: ${fit.name}` })).toBeVisible()
  await expect(chip).toContainText('Picked for this kind of video')
  await chip.getByRole('button', { name: `Look: ${fit.name}` }).click()
  await card(page, other.id).click()
  await expect(chip.getByRole('button', { name: `Look: ${other.name}` })).toBeVisible()
  await dialog.getByRole('button', { name: 'Create with this brief' }).click()
  await expect.poll(() => sent(page)).toMatchObject({ planId: 'plan_mock', look: other.id })
})

test('a look picked before planning goes to the plan and the brief shows it', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('button', { name: 'Look: Agent decides' }).click()
  await card(page, 'terminal').click()
  await page
    .getByLabel('What should the video show?')
    .fill('A 30-second launch video for org-wide webhooks, ending on our logo.')
  await page.getByRole('button', { name: 'Create video', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Plan it first/ })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as { __sent?: Record<string, { look?: unknown }> }).__sent?.['/api/v1/plans']
            ?.look,
      ),
    )
    .toBe('terminal')
  const dialog = page.getByRole('dialog', { name: 'Plan your video' })
  await dialog.getByRole('button', { name: 'Next' }).click()
  await dialog.getByRole('button', { name: 'Write the brief' }).click()
  await expect(dialog.getByTestId('plan-look').getByRole('button', { name: 'Look: Terminal' })).toBeVisible()
  await expect(dialog.getByTestId('plan-look')).not.toContainText('Picked for this kind of video')
})
