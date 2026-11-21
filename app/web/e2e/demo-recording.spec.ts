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
  await page.getByRole('button', { name: 'Look: Agent decides' }).click()
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

/** Opens setup for the mock's plain recording (1280x720; its sample file is 8 s long). */
async function openSetup(page: Page) {
  await page.goto('/new/demo?media=med_screen_plain')
  await expect(page.getByTestId('demo-setup')).toBeVisible()
  const canvas = page.getByTestId('box-canvas')
  await canvas.scrollIntoViewIfNeeded()
  return canvas
}
const videoState = (page: Page) =>
  page.evaluate<{ t: number; paused: boolean; muted: boolean }>(`(() => {
    const v = document.querySelector('[data-testid="box-canvas"] video')
    return { t: v.currentTime, paused: v.paused, muted: v.muted }
  })()`)
/** Drags from one point of an element's box to another (fractions of it). */
async function dragIn(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  from: [number, number],
  to: [number, number],
) {
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 6 })
  await page.mouse.up()
}

test('play the recording: play and pause, scrub, sound, and it stops at the end of the trim', async ({
  page,
}) => {
  await openSetup(page)
  const player = page.getByTestId('recording-player')
  await expect(player).toBeVisible()
  await expect(player.getByTestId('player-time')).toHaveText('0:00.0 / 1:35.0')
  // The recording's own sound is on until muted.
  expect((await videoState(page)).muted).toBe(false)

  await player.getByRole('button', { name: 'Play' }).click()
  await expect(player.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect.poll(async () => (await videoState(page)).t).toBeGreaterThan(0.3)
  await expect(player.getByTestId('player-time')).not.toHaveText('0:00.0 / 1:35.0')
  await player.getByRole('button', { name: 'Pause' }).click()
  await expect(player.getByRole('button', { name: 'Play' })).toBeVisible()
  const paused = await videoState(page)
  expect(paused.paused).toBe(true)

  // Scrub with the keyboard: a tenth of a second a press.
  await player.getByRole('slider', { name: 'Position' }).focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await videoState(page)).t).toBeGreaterThan(paused.t + 0.8)

  await player.getByRole('button', { name: 'Mute' }).click()
  expect((await videoState(page)).muted).toBe(true)
  await player.getByRole('button', { name: 'Turn sound on' }).click()
  expect((await videoState(page)).muted).toBe(false)

  // Trim to about 2-5 s: the start with the keyboard, the end by dragging its handle. Playback follows the trim.
  await page.getByRole('slider', { name: 'Start' }).focus()
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight')
  const end = await page.getByRole('slider', { name: 'End' }).boundingBox()
  const track = await page.getByRole('slider', { name: 'Start' }).boundingBox()
  if (!end || !track) throw new Error('no trim handles')
  // The start handle sits at 2 s of 95: the track's left edge is that far to its left.
  const trackBox = await page.locator('.mantine-RangeSlider-track').first().boundingBox()
  if (!trackBox) throw new Error('no trim track')
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2)
  await page.mouse.down()
  await page.mouse.move(trackBox.x + trackBox.width * (5 / 95), end.y + end.height / 2, { steps: 8 })
  await page.mouse.up()
  const label = (await page.getByTestId('trim-label').textContent()) ?? ''
  const out = Number(/– 0:0?(\d+\.\d)/.exec(label)?.[1])
  console.log(JSON.stringify({ test: 'demo-recording', case: 'play-trim', label, out }))
  expect(out).toBeGreaterThanOrEqual(4)
  expect(out).toBeLessThan(8)
  // The handle moved the picture to the trim's end; Play starts again from its start and stops at its end.
  await player.getByRole('button', { name: 'Play' }).click()
  await expect(player.getByRole('button', { name: 'Pause' })).toBeVisible()
  const started = (await videoState(page)).t
  expect(started).toBeGreaterThanOrEqual(1.9)
  expect(started).toBeLessThan(out - 0.2)
  await expect(player.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 15_000 })
  const stopped = await videoState(page)
  expect(stopped.paused).toBe(true)
  expect(Math.abs(stopped.t - out)).toBeLessThan(0.15)
  // Nothing spills past the page at any width (the phone project runs this too).
  expect(
    await page.evaluate<boolean>(
      'document.documentElement.scrollWidth <= document.documentElement.clientWidth',
    ),
  ).toBe(true)
})

test('crop the picture: resize the rectangle, hide something inside it, and the demo is made with the crop', async ({
  page,
}) => {
  const canvas = await openSetup(page)
  await expect(page.getByTestId('crop-overlay')).toHaveCount(0)
  await page.getByRole('button', { name: 'Crop', exact: true }).click()
  await expect(page.getByTestId('crop-note')).toContainText('Drag the corners and edges')
  const r = await canvas.boundingBox()
  if (!r) throw new Error('no canvas')
  // Corners in from the whole frame, then the box moved, then an edge nudged with the keyboard.
  await dragIn(page, r, [0.02, 0.03], [0.22, 0.13])
  await dragIn(page, r, [0.98, 0.97], [0.68, 0.77])
  await dragIn(page, r, [0.45, 0.45], [0.5, 0.55])
  await page.getByRole('button', { name: 'Crop right edge' }).focus()
  await page.keyboard.press('ArrowRight')
  // While cropping, the picture doesn't take hidden areas.
  await expect(page.getByTestId('hidden-box')).toHaveCount(0)
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('button', { name: 'Crop top left corner' })).toHaveCount(0)
  await expect(page.getByTestId('crop-note')).toContainText('of the 1280×720 picture')
  await expect(page.getByRole('button', { name: 'Change crop' })).toBeVisible()
  // The part kept is small for a 16:9 video: the note names it.
  await expect(page.getByTestId('low-res-note')).toContainText('The part you keep is')

  // Hidden areas are still drawn on the whole picture.
  await dragIn(page, r, [0.4, 0.4], [0.5, 0.5])
  await expect(page.getByTestId('hidden-box')).toHaveCount(1)
  await page
    .getByLabel('What should the demo show?')
    .fill('A short demo of the settings page for new admins.')
  await page.getByRole('button', { name: 'Make it' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  const [body] = (await creates(page)) as {
    recording: { crop?: number[]; redact?: { box: number[] }[]; trim?: number[] }
  }[]
  console.log(JSON.stringify({ test: 'demo-recording', case: 'crop', recording: body?.recording }))
  const crop = body?.recording.crop ?? []
  expect(crop).toHaveLength(4)
  // (0.2, 0.1)-(0.7, 0.8) moved by (0.05, 0.1), the right edge out by 0.01.
  expect(crop[0]).toBeCloseTo(0.25, 1)
  expect(crop[1]).toBeCloseTo(0.2, 1)
  expect(crop[2]).toBeCloseTo(0.51, 1)
  expect(crop[3]).toBeCloseTo(0.7, 1)
  expect((crop[0] ?? 0) + (crop[2] ?? 0)).toBeLessThanOrEqual(1)
  expect(body?.recording.trim).toBeUndefined()
  // The box is in fractions of the whole frame.
  expect(body?.recording.redact?.[0]?.box[0]).toBeCloseTo(0.4, 1)
})

test('crop: Reset puts the whole picture back, and nothing is sent', async ({ page }) => {
  const canvas = await openSetup(page)
  await page.getByRole('button', { name: 'Crop', exact: true }).click()
  const r = await canvas.boundingBox()
  if (!r) throw new Error('no canvas')
  // Drawing on the picture makes a new rectangle.
  await dragIn(page, r, [0.3, 0.3], [0.8, 0.9])
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByTestId('crop-overlay')).toBeVisible()
  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page.getByTestId('crop-overlay')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Crop', exact: true })).toBeVisible()
  await page
    .getByLabel('What should the demo show?')
    .fill('A short demo of the settings page for new admins.')
  await page.getByRole('button', { name: 'Make it' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  const [body] = (await creates(page)) as { recording: Record<string, unknown> }[]
  expect(body?.recording).toEqual({ mediaId: 'med_screen_plain' })
})
