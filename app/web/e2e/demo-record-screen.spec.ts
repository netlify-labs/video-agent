// Record in the app (screen-recording plan §4.5, path B; va-rsk5.4.7) on the mock build: a canvas stands in for the
// shared screen, encoded live with Mediabunny, uploaded, and setup opens. In Chrome: Playwright's own Chromium has no
// H.264 encoder for WebCodecs. Neither has Chrome on GitHub's Linux runners, so there it skips with a log line (the
// unsupported message is covered in demo-recording.spec.ts); it runs where Chrome can encode, as on macOS.
import { expect, test } from '@playwright/test'

test.use({ channel: 'chrome' })

test('record the screen in the app: a shared canvas becomes a recording and opens setup', async ({
  page,
}) => {
  // A canvas stands in for the shared screen: an animated picture at 1280x720 from captureStream(30).
  await page.addInitScript({
    content: `navigator.mediaDevices.getDisplayMedia = () => {
    const c = document.createElement('canvas')
    c.width = 1280
    c.height = 720
    const cx = c.getContext('2d')
    let n = 0
    const draw = () => {
      cx.fillStyle = 'hsl(' + (n++ % 360) + ' 60% 50%)'
      cx.fillRect(0, 0, c.width, c.height)
      cx.fillStyle = '#fff'
      cx.fillRect((n * 7) % c.width, 300, 80, 80)
      requestAnimationFrame(draw)
    }
    draw()
    return Promise.resolve(c.captureStream(30))
  }`,
  })
  await page.goto('/new/demo')
  await page.getByRole('button', { name: 'Record your screen' }).click()
  const cant = page.getByText("This browser can't record the screen here")
  await expect(page.getByText("Recordings made here don't include cursor data").or(cant)).toBeVisible()
  if (await cant.isVisible()) {
    console.log(
      JSON.stringify({
        test: 'demo-recording',
        case: 'record',
        skipped: 'no H.264 encoder in this Chrome',
      }),
    )
    test.skip(true, 'This Chrome has no H.264 encoder for WebCodecs.')
  }
  await page.getByRole('button', { name: 'Choose what to record' }).click()
  await expect(page.getByTestId('record-elapsed')).toContainText('0:01', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Stop recording' }).click()
  await expect(page).toHaveURL(/\?media=med_screen_up/, { timeout: 30_000 })
  await expect(page.getByTestId('cursor-note')).toHaveText(
    'Video Agent will look for your cursor in the picture.',
  )
})

test('New video: Record screen beside Add media records, its setup opens in a dialog, and the recording is added to the form', async ({
  page,
}) => {
  await page.addInitScript({
    content: `navigator.mediaDevices.getDisplayMedia = () => {
    const c = document.createElement('canvas')
    c.width = 1280
    c.height = 720
    const cx = c.getContext('2d')
    let n = 0
    const draw = () => {
      cx.fillStyle = 'hsl(' + (n++ % 360) + ' 60% 50%)'
      cx.fillRect(0, 0, c.width, c.height)
      requestAnimationFrame(draw)
    }
    draw()
    return Promise.resolve(c.captureStream(30))
  }`,
  })
  await page.goto('/new')
  await page
    .getByLabel('What should the video show?')
    .fill('A short demo of the settings page for new admins.')
  // Right beside Add media, on the same line, and both look like buttons (bordered).
  const add = page.getByRole('button', { name: 'Add media' })
  const record = page.getByRole('button', { name: 'Record screen' })
  await expect(record).toBeVisible()
  const [a, b] = [await add.boundingBox(), await record.boundingBox()]
  expect(Math.abs((a?.y ?? 0) - (b?.y ?? 99))).toBeLessThan(4)
  for (const button of [add, record]) await expect(button).toHaveAttribute('data-variant', 'default')
  await record.click()
  const dialog = page.getByRole('dialog', { name: 'Record your screen' })
  const cant = dialog.getByText("This browser can't record the screen here")
  await expect(dialog.getByText("Recordings made here don't include cursor data").or(cant)).toBeVisible()
  if (await cant.isVisible()) test.skip(true, 'This Chrome has no H.264 encoder for WebCodecs.')
  // Back closes the dialog; the page is as it was.
  await dialog.getByRole('button', { name: 'Back' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/\/new$/)

  await record.click()
  await dialog.getByRole('button', { name: 'Choose what to record' }).click()
  await expect(dialog.getByTestId('record-elapsed')).toContainText('0:04', { timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Stop recording' }).click()
  // The recording's own setup (the same component as /new/demo), without the demo's form. Nothing is uploaded yet.
  const setup = page.getByRole('dialog', { name: 'Set up your recording' })
  await expect(setup.getByTestId('demo-setup')).toBeVisible({ timeout: 30_000 })
  const uploads = () => page.evaluate<Record<string, string>>('window.__mockRecordingFiles ?? {}')
  expect(Object.keys(await uploads())).toHaveLength(0)
  await expect(setup.getByTestId('recording-player')).toBeVisible()
  await expect(setup.getByLabel('Privacy mode')).toBeVisible()
  await expect(setup.getByLabel('What should the demo show?')).toHaveCount(0)
  await expect(setup.getByRole('button', { name: 'Make it' })).toHaveCount(0)
  await expect(setup.getByText('only the edited clip goes to your library')).toBeVisible()
  // Trim a second off the start.
  await setup.getByRole('slider', { name: 'Start' }).focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  const label = (await setup.getByTestId('trim-label').textContent()) ?? ''
  const used = Number(/\((\d+\.\d) s used\)/.exec(label)?.[1])
  expect(used).toBeGreaterThan(2)
  // Crop to (0.2, 0.2)-(0.8, 0.9): 768x504 of the 1280x720 picture.
  const canvas = setup.getByTestId('box-canvas')
  await canvas.scrollIntoViewIfNeeded()
  const r = await canvas.boundingBox()
  if (!r) throw new Error('no canvas')
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    await page.mouse.move(r.x + r.width * x0, r.y + r.height * y0)
    await page.mouse.down()
    await page.mouse.move(r.x + r.width * x1, r.y + r.height * y1, { steps: 5 })
    await page.mouse.up()
  }
  await setup.getByRole('button', { name: 'Crop', exact: true }).click()
  await drag(0.2, 0.2, 0.8, 0.9)
  await setup.getByRole('button', { name: 'Done' }).click()
  // Hide (0.4, 0.4)-(0.6, 0.6) with a solid box.
  await drag(0.4, 0.4, 0.6, 0.6)
  await setup.getByRole('radiogroup', { name: 'Area 1 style' }).getByText('Solid').click()
  // It hides from 2.5 s of the recording, which is 1.5 s into the trimmed clip.
  await setup.getByLabel('Area 1 from').fill('2.5')
  await setup.getByRole('button', { name: 'Add to video' }).click()

  // It's on the form with the picked media, removable; no video was created yet.
  await expect(setup).toHaveCount(0, { timeout: 60_000 })
  await expect(page).toHaveURL(/\/new$/)
  const chip = page.getByTestId('chip-recording')
  await expect(chip).toContainText('Screen recording')
  await expect(chip).toContainText('cropped')
  await expect(chip).toContainText('1 hidden')
  await expect(page.getByTestId('recording-note')).toContainText('the video is a demo of it')
  expect(await page.evaluate<unknown[]>('window.__mockDemoCreates ?? []')).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Remove the screen recording' })).toBeVisible()

  // What was uploaded is the edited clip: trimmed, cropped, the box drawn into the picture.
  const files = await uploads()
  expect(Object.keys(files)).toHaveLength(1)
  const clip = await page.evaluate<{
    width: number
    height: number
    duration: number
    box: number[]
    outside: number[]
    before: number[]
  }>(`(async () => {
    const v = document.createElement('video')
    v.muted = true
    v.src = ${JSON.stringify(Object.values(files)[0])}
    await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = no })
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const cx = c.getContext('2d', { willReadFrequently: true })
    const at = async (t) => {
      v.currentTime = t
      await new Promise((ok) => { v.onseeked = ok })
      cx.drawImage(v, 0, 0)
    }
    const px = (x, y) => [...cx.getImageData(x, y, 1, 1).data].slice(0, 3)
    // The box's centre is (0.5, 0.5) of the frame: (640 - 256, 360 - 144) in the cropped picture.
    await at(1)
    const before = px(384, 216)
    await at(2.4)
    return { width: v.videoWidth, height: v.videoHeight, duration: v.duration, box: px(384, 216), outside: px(60, 60), before }
  })()`)
  console.log(JSON.stringify({ test: 'demo-recording', case: 'new-video-record-clip', used, clip }))
  expect(clip.width).toBe(768)
  expect(clip.height).toBe(504)
  expect(Math.abs(clip.duration - used)).toBeLessThan(0.25)
  // The solid box is #9aa3ad; the picture around it is a saturated colour.
  for (const [i, want] of [154, 163, 173].entries())
    expect(Math.abs((clip.box[i] ?? 0) - want)).toBeLessThan(20)
  expect(Math.max(...clip.outside) - Math.min(...clip.outside)).toBeGreaterThan(60)
  // A second into the clip (2 s of the recording) the box isn't showing yet.
  expect(Math.max(...clip.before) - Math.min(...clip.before)).toBeGreaterThan(60)

  // Create video sends it as the request's recording; the edits are in the file, not the request.
  await page.getByRole('button', { name: 'Create video' }).click()
  await page.getByRole('button', { name: /Create it now/ }).click()
  await expect(page).toHaveURL(/\/videos\//)
  const creates = await page.evaluate<
    { prompt: string; engine?: string; recording?: Record<string, unknown> }[]
  >('window.__mockDemoCreates ?? []')
  const body = creates.at(-1)
  console.log(JSON.stringify({ test: 'demo-recording', case: 'new-video-record', body }))
  expect(body?.prompt).toBe('A short demo of the settings page for new admins.')
  expect(body?.engine).toBe('hyperframes')
  expect(body?.recording).toEqual({ mediaId: Object.keys(files)[0] })
})

test('New video: no Record screen button when screen recording is off', async ({ page }) => {
  await page.addInitScript({ content: `localStorage.setItem('mockNoScreenRecording', '1')` })
  await page.goto('/new')
  await expect(page.getByRole('button', { name: 'Add media' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record screen' })).toHaveCount(0)
})
