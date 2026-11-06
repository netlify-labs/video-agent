// New video -> From a screen recording on the mock build (screen-recording plan §4.3–4.5; va-rsk5.4.1, 4.2, 4.7):
// the library's recordings (cursor data first, with its badge), setup (notes, draw, move and delete boxes, trim, the
// private hint, the create request), uploading a normalized MP4 with its trace.json, and recording the screen in the
// app (demo-record-screen.spec.ts). Without getDisplayMedia, Record says it can't.
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MP4 = fileURLToPath(new URL('../../test/fixtures/mp4/gop30.mp4', import.meta.url))
// Browser-side code goes in as strings: the e2e files are typechecked without the DOM.
const creates = (page: Page) => page.evaluate<unknown[]>('window.__mockDemoCreates ?? []')

test('pick a recording, hide something, trim, and make the demo', async ({ page }) => {
  await page.goto('/new')
  await page.getByRole('link', { name: 'From a screen recording' }).click()
  await expect(page).toHaveURL(/\/new\/demo$/)
  const picks = page.getByRole('button', { name: /^Use / })
  await expect(picks).toHaveCount(2)
  // Cursor data first, with its badge.
  await expect(picks.first()).toContainText('Add a webhook')
  await expect(picks.first()).toContainText('Exact cursor')
  await picks.nth(1).click()
  await expect(page).toHaveURL(/\/new\/demo\?media=med_screen_plain/)
  const setup = page.getByTestId('demo-setup')
  await expect(setup.getByTestId('cursor-note')).toHaveText(
    'Video Agent will look for your cursor in the picture.',
  )
  await expect(setup.getByText('can also watch the full recording')).toBeVisible()
  await expect(setup.getByText("Video Agent's AI looks at frames from your recording.")).toBeVisible()
  await expect(page.getByTestId('private-hint')).toHaveCount(0)
  // 1280x720 is small for a 1920x1080 demo: the camera holds back, and setup says how to get sharp zooms.
  await expect(page.getByTestId('low-res-note')).toContainText('record at 2x or in a larger window')

  // Draw two boxes, move the first, delete the second.
  const canvas = page.getByTestId('box-canvas')
  await canvas.scrollIntoViewIfNeeded()
  const r = await canvas.boundingBox()
  if (!r) throw new Error('no canvas')
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    await page.mouse.move(r.x + r.width * x0, r.y + r.height * y0)
    await page.mouse.down()
    await page.mouse.move(r.x + r.width * x1, r.y + r.height * y1, { steps: 5 })
    await page.mouse.up()
  }
  await drag(0.1, 0.1, 0.3, 0.2)
  await drag(0.6, 0.6, 0.8, 0.8)
  await expect(page.getByTestId('hidden-box')).toHaveCount(2)
  await expect(page.getByTestId('private-hint')).toBeVisible()
  await drag(0.2, 0.15, 0.4, 0.25)
  await page.getByRole('button', { name: 'Delete area 2' }).click()
  await expect(page.getByTestId('hidden-box')).toHaveCount(1)
  await page.getByLabel('Area 1 to').fill('40')
  // Blurred by default; this one solid.
  await page.getByRole('radiogroup', { name: 'Area 1 style' }).getByText('Solid').click()

  // Trim the start by 5 s with the keyboard: the length follows (90 s used -> 36 s).
  await page.getByRole('slider', { name: 'Start' }).focus()
  for (let i = 0; i < 50; i++) await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('trim-label')).toContainText('90.0 s used')
  await expect(page.getByLabel('Length')).toHaveValue('36 s')

  await page
    .getByLabel('What should the demo show?')
    .fill('A short demo of the settings page for new admins.')
  // Privacy mode is off unless ticked.
  await expect(page.getByLabel('Privacy mode')).not.toBeChecked()
  await page.getByLabel('Privacy mode').check()
  await page.getByLabel('Hide these words').fill('Priya Raman\n\n  Acme Labs  \nPriya Raman')
  await page.getByRole('button', { name: 'Make it' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  const [body] = (await creates(page)) as {
    recording: { mediaId: string; trim?: number[]; redact?: { start: number; end: number; box: number[] }[] }
    durationSec: number
  }[]
  console.log(JSON.stringify({ test: 'demo-recording', case: 'create', recording: body?.recording }))
  expect(body?.durationSec).toBe(36)
  expect(body?.recording.mediaId).toBe('med_screen_plain')
  expect((body?.recording as { privacy?: boolean } | undefined)?.privacy).toBe(true)
  expect((body?.recording as { hideStrings?: string[] } | undefined)?.hideStrings).toEqual([
    'Priya Raman',
    'Acme Labs',
  ])
  expect(body?.recording.trim).toEqual([5, 95])
  expect(body?.recording.redact).toHaveLength(1)
  const box = body?.recording.redact?.[0]
  expect(box).toMatchObject({ start: 0, end: 40, style: 'solid' })
  // Dragged by (0.2, 0.1) from (0.1, 0.1).
  expect(box?.box[0]).toBeCloseTo(0.3, 1)
  expect(box?.box[1]).toBeCloseTo(0.2, 1)
})

test('a recording with cursor data says so in setup; a 2x one has no low-resolution note', async ({
  page,
}) => {
  await page.goto('/new/demo?media=med_screen_trace')
  await expect(page.getByTestId('cursor-note')).toHaveText('Smooth cursor from your cursor data.')
  // 2560x1440 zooms sharply: no low-resolution note.
  await expect(page.getByTestId('low-res-note')).toHaveCount(0)
})

test('upload a normalized MP4 with its trace.json: no conversion, the trace is sent, then setup', async ({
  page,
}) => {
  await page.goto('/new/demo')
  const trace = {
    v: 1,
    source: { kind: 'cli', tool: 'video-agent record', startedAt: '2026-11-06T00:00:00.000Z' },
    frame: { width: 320, height: 180, fps: 30, duration: 3 },
    viewport: { width: 320, height: 180, dpr: 1 },
    moves: [],
    events: [],
    redact: [],
  }
  await page.getByLabel('Screen recording file').setInputFiles([
    { name: 'take.mp4', mimeType: 'video/mp4', buffer: readFileSync(MP4) },
    { name: 'trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trace)) },
  ])
  await expect(page).toHaveURL(/\?media=med_screen_up/, { timeout: 30_000 })
  await expect(page.getByTestId('cursor-note')).toHaveText('Smooth cursor from your cursor data.')
  const sent = await page.evaluate<Record<string, unknown>>('window.__mockTraces ?? {}')
  expect(Object.values(sent)).toEqual([trace])
})

test("without screen sharing, Record says this browser can't", async ({ page }) => {
  await page.addInitScript({
    content: "Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined })",
  })
  await page.goto('/new/demo')
  await page.getByRole('button', { name: 'Record your screen' }).click()
  await expect(page.getByText("This browser can't record the screen here")).toBeVisible()
})

test('the demo look picker leaves out looks that hide recordings; such a default is None and sent as null', async ({
  page,
}) => {
  // retro-crt has recording: false.
  await page.addInitScript(() => localStorage.setItem('mockLookDefault', 'retro-crt'))
  await page.goto('/new/demo?media=med_screen_plain')
  await page.getByRole('button', { name: 'Look: None' }).click()
  const dialog = page.getByRole('dialog', { name: 'Pick a look' })
  await expect(dialog.locator('.va-look-pick[data-look="clean"]')).toBeVisible()
  await expect(dialog.locator('.va-look-pick[data-look="retro-crt"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page
    .getByLabel('What should the demo show?')
    .fill('A short demo of the settings page for new admins.')
  await page.getByRole('button', { name: 'Make it' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  const [body] = (await creates(page)) as { look?: string | null }[]
  expect(body?.look).toBeNull()
})
