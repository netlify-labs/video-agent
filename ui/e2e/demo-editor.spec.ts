// The editor's recording panels on the mock build (screen-recording plan §8.2; va-rsk5.4.4, 4.5, the phase 3 gate):
// a demo's recording scene (mockDemo: test/fixtures/contract1-recording) gets Trim, Camera, Cursor and Hide; each
// change autosaves as the API's own op (span, camera, cursor, redact), which the mock applies with the real patcher.
import { expect, test, type Page } from '@playwright/test'

type Op = { op: string; beat?: string; [k: string]: unknown }
const saved = (page: Page) =>
  page.evaluate<Op[]>(
    "Object.entries(window.__sent ?? {}).filter(([p]) => p.startsWith('/api/v1/edits/')).map(([, b]) => b.ops ?? []).at(-1) ?? []",
  )
const opOf = async (page: Page, name: string) => (await saved(page)).find((o) => o.op === name)

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: "localStorage.setItem('mockDemo', '1')" })
  await page.goto('/videos/vid_teaser/edit/2')
})

test('a recording scene has its panels; trim, camera, cursor and hide save as ops', async ({ page }) => {
  const panel = page.getByTestId('recording-panel-add-site')
  await expect(panel).toBeVisible()
  // Trim: source 2-12 s over 7.5 s plays at 1.33x; moving In to 2.5 s makes it 1.27x.
  await expect(panel.getByTestId('trim-speed')).toHaveText('1.33x')
  await panel.getByRole('slider', { name: 'In' }).focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await expect(panel.getByTestId('trim-speed')).toHaveText('1.27x')
  await expect.poll(async () => opOf(page, 'span')).toMatchObject({ beat: 'add-site', in: 2.5, out: 12 })

  // Camera: No zoom leaves one key at the span's start.
  await panel.getByRole('tab', { name: 'Camera' }).click()
  await panel.getByRole('button', { name: 'No zoom' }).click()
  await expect(panel.getByTestId('camera-keys').locator('> *')).toHaveCount(1)
  await expect.poll(async () => opOf(page, 'camera')).toMatchObject({ keys: [[2.5, 0.5, 0.5, 1]] })
  // Auto puts the planner's camera back (its keys inside the span).
  await panel.getByRole('button', { name: 'Auto' }).click()
  await expect(panel.getByTestId('camera-keys').locator('> *')).toHaveCount(4)

  // Cursor: highlight, and smooth stays available (this recording has cursor data).
  await panel.getByRole('tab', { name: 'Cursor' }).click()
  await panel.getByText('Highlight').click()
  await expect.poll(async () => opOf(page, 'cursor')).toMatchObject({ style: 'highlight' })

  // Hide: the setup box is listed, locked, with why; a drawn box is the scene's own, blurred, then solid.
  await panel.getByRole('tab', { name: 'Hide' }).click()
  await expect(panel.getByTestId('locked-area')).toContainText('You drew it')
  const canvas = panel.getByTestId('box-canvas')
  await canvas.scrollIntoViewIfNeeded()
  const r = await canvas.boundingBox()
  if (!r) throw new Error('no canvas')
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(r.x + r.width * 0.4, r.y + r.height * 0.3, { steps: 4 })
  await page.mouse.up()
  await expect(panel.getByTestId('scene-area')).toHaveCount(1)
  await panel.getByRole('radiogroup', { name: 'e1 style' }).getByText('Solid').click()
  await expect
    .poll(
      async () =>
        ((await opOf(page, 'redact'))?.entries as { id: string; style?: string }[] | undefined)?.[0],
    )
    .toMatchObject({ id: 'e1', style: 'solid' })
  // Removing it leaves the scene with none of its own (the locked one stays).
  await panel.getByRole('button', { name: 'Remove e1' }).click()
  await expect(panel.getByTestId('scene-area')).toHaveCount(0)
  await expect(panel.getByTestId('locked-area')).toHaveCount(1)
})

test('a span that would play past 4x says so', async ({ page }) => {
  const panel = page.getByTestId('recording-panel-add-site')
  // Out to the recording's end (20 s): 18 s over 7.5 s is 2.4x (amber); the length field to 3 s makes it 6x.
  await panel.getByRole('slider', { name: 'Out' }).focus()
  for (let i = 0; i < 160; i++) await page.keyboard.press('ArrowRight')
  await expect(panel.getByTestId('trim-speed')).toHaveText('2.4x')
  await page.getByLabel('Length of Add a site').fill('3')
  await expect(panel.getByTestId('trim-speed')).toContainText('too fast')
})
