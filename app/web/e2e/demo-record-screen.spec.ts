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
  await expect(dialog.getByTestId('record-elapsed')).toContainText('0:01', { timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Stop recording' }).click()
  // Uploaded: the recording's own setup (the same component as /new/demo), without the demo's form.
  const setup = page.getByRole('dialog', { name: 'Set up your recording' })
  await expect(setup.getByTestId('demo-setup')).toBeVisible({ timeout: 30_000 })
  await expect(setup.getByTestId('recording-player')).toBeVisible()
  await expect(setup.getByRole('slider', { name: 'Start' })).toBeVisible()
  await expect(setup.getByLabel('Privacy mode')).toBeVisible()
  await expect(setup.getByLabel('What should the demo show?')).toHaveCount(0)
  await expect(setup.getByRole('button', { name: 'Make it' })).toHaveCount(0)
  // Crop it: draw a rectangle on the picture.
  await setup.getByRole('button', { name: 'Crop', exact: true }).click()
  const canvas = setup.getByTestId('box-canvas')
  await canvas.scrollIntoViewIfNeeded()
  const r = await canvas.boundingBox()
  if (!r) throw new Error('no canvas')
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(r.x + r.width * 0.8, r.y + r.height * 0.9, { steps: 5 })
  await page.mouse.up()
  await setup.getByRole('button', { name: 'Done' }).click()
  await setup.getByRole('button', { name: 'Add to video' }).click()

  // It's on the form with the picked media, removable; nothing was created yet.
  await expect(setup).toHaveCount(0)
  await expect(page).toHaveURL(/\/new$/)
  const chip = page.getByTestId('chip-recording')
  await expect(chip).toContainText('Screen recording')
  await expect(chip).toContainText('cropped')
  await expect(page.getByTestId('recording-note')).toContainText('the video is a demo of it')
  expect(await page.evaluate<unknown[]>('window.__mockDemoCreates ?? []')).toHaveLength(0)
  await expect(page.getByLabel('What should the video show?')).toHaveValue(
    'A short demo of the settings page for new admins.',
  )
  await expect(page.getByRole('button', { name: 'Remove the screen recording' })).toBeVisible()

  // Create video sends it as the request's recording, with its crop.
  await page.getByRole('button', { name: 'Create video' }).click()
  await page.getByRole('button', { name: /Create it now/ }).click()
  await expect(page).toHaveURL(/\/videos\//)
  const creates = await page.evaluate<
    { prompt: string; engine?: string; recording?: { mediaId: string; crop?: number[] } }[]
  >('window.__mockDemoCreates ?? []')
  const body = creates.at(-1)
  console.log(JSON.stringify({ test: 'demo-recording', case: 'new-video-record', body }))
  expect(body?.prompt).toBe('A short demo of the settings page for new admins.')
  expect(body?.engine).toBe('hyperframes')
  expect(body?.recording?.mediaId).toMatch(/^med_screen_up/)
  expect(body?.recording?.crop?.[0]).toBeCloseTo(0.2, 1)
  expect(body?.recording?.crop?.[2]).toBeCloseTo(0.6, 1)
})

test('New video: no Record screen button when screen recording is off', async ({ page }) => {
  await page.addInitScript({ content: `localStorage.setItem('mockNoScreenRecording', '1')` })
  await page.goto('/new')
  await expect(page.getByRole('button', { name: 'Add media' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record screen' })).toHaveCount(0)
})
