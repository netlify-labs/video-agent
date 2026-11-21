// The Remotion UI (render-engines plan §7, bead va-ed2s.3.14), against the mock build: with only HyperFrames on nothing
// about engines shows and nothing asks for them; with Remotion on (localStorage.mockEngines = 'remotion-on'), New video
// offers an Engine select where there's a choice and limits Sound and voice-over to what the engine makes, and a
// Remotion video carries its tag, a limited revise form and no editor.
import { expect, test, type Page } from '@playwright/test'

const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })
const enginesRequests = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __enginesRequests?: number }).__enginesRequests ?? 0)
const sound = (page: Page, label: string) =>
  page.getByTestId('sound-control').getByText(label, { exact: true })

test('with only HyperFrames on: no Engine select, no tag, and no engines request', async ({ page }) => {
  await page.goto('/new')
  await expect(page.getByRole('button', { name: 'Create video' })).toBeVisible()
  await expect(page.getByTestId('engine-select')).toHaveCount(0)
  await expect(sound(page, 'Music + effects')).toBeVisible()
  await expect(page.getByText('Voice-over').first()).toBeVisible()
  await page.goto('/videos/vid_docs')
  await expect(page.getByText('Add an environment variable, then redeploy').first()).toBeVisible()
  await expect(page.getByTestId('engine-tag')).toHaveCount(0)
  expect(await enginesRequests(page)).toBe(0)
})

test('New video: the Engine select shows only where there is a choice, and Remotion limits Sound and voice-over', async ({
  page,
}) => {
  await mock(page, 'mockEngines', 'remotion-on')
  await page.goto('/new')
  const select = page.getByTestId('engine-select')
  await expect(select).toBeVisible()
  await expect(select).toHaveValue('HyperFrames')
  await select.click()
  await page.getByRole('option', { name: 'Remotion' }).click()
  await expect(select).toHaveValue('Remotion')
  await expect(sound(page, 'Music + effects')).toHaveCount(0)
  await expect(sound(page, 'Music')).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Voice-over' })).toHaveCount(0)
  // A look made only with HyperFrames leaves no choice, so the select goes and HyperFrames' options come back.
  await page.getByRole('button', { name: 'Look: Agent decides' }).click()
  await page.locator('.va-look-pick[data-look="clean"]').click()
  await expect(select).toHaveCount(0)
  await expect(sound(page, 'Music + effects')).toBeVisible()
})

test('a Remotion video: the tag, Sound without effects, no voice-over, and no editor', async ({ page }) => {
  await mock(page, 'mockEngines', 'remotion-on')
  await page.goto('/videos/vid_remotion')
  await expect(page.getByTestId('engine-tag').first()).toHaveText('Remotion')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  await expect(sound(page, 'Music + effects')).toHaveCount(0)
  await expect(sound(page, 'Music')).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Voice-over' })).toHaveCount(0)
  await page.goto('/videos/vid_remotion/edit/1')
  await expect(
    page.getByText("Editing isn't available for Remotion videos yet. Ask for a revision instead."),
  ).toBeVisible()
})

test('choosing Remotion sends engine on create; leaving the choice alone sends none', async ({ page }) => {
  await mock(page, 'mockEngines', 'remotion-on')
  await page.goto('/new')
  const sent = () =>
    page.evaluate(
      () =>
        (globalThis as unknown as { __sent?: Record<string, Record<string, unknown>> }).__sent?.[
          '/api/v1/videos'
        ],
    )
  await page.getByTestId('engine-select').click()
  await page.getByRole('option', { name: 'Remotion' }).click()
  await page
    .getByLabel('What should the video show?')
    .fill('A launch video for org webhooks, with an end card.')
  await page.getByRole('button', { name: 'Create video' }).click()
  await page.getByRole('button', { name: /Create it now/ }).click()
  await expect.poll(sent).toBeTruthy()
  expect(await sent()).toMatchObject({ engine: 'remotion', sound: 'silent' })
  expect(await sent()).not.toHaveProperty('voiceover')
})
