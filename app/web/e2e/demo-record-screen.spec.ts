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

test('New video: Record screen beside Add media records, then setup opens in a dialog and makes the demo', async ({
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
  // Right beside Add media, on the same line.
  const add = page.getByRole('button', { name: 'Add media' })
  const record = page.getByRole('button', { name: 'Record screen' })
  await expect(record).toBeVisible()
  const [a, b] = [await add.boundingBox(), await record.boundingBox()]
  expect(Math.abs((a?.y ?? 0) - (b?.y ?? 99))).toBeLessThan(4)
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
  // Uploaded: the same setup as /new/demo, in the dialog, with the prompt already typed.
  const setup = page.getByRole('dialog', { name: 'Make a demo from your recording' })
  await expect(setup.getByTestId('demo-setup')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/new$/)
  await expect(setup.getByTestId('recording-player')).toBeVisible()
  await expect(setup.getByRole('button', { name: 'Crop', exact: true })).toBeVisible()
  await expect(setup.getByLabel('What should the demo show?')).toHaveValue(
    'A short demo of the settings page for new admins.',
  )
  await setup.getByRole('button', { name: 'Make it' }).click()
  await expect(page).toHaveURL(/\/videos\//)
  const creates = await page.evaluate<{ recording?: { mediaId: string } }[]>('window.__mockDemoCreates ?? []')
  expect(creates.at(-1)?.recording?.mediaId).toMatch(/^med_screen_up/)
})

test('New video: no Record screen button when screen recording is off', async ({ page }) => {
  await page.addInitScript({ content: `localStorage.setItem('mockNoScreenRecording', '1')` })
  await page.goto('/new')
  await expect(page.getByRole('button', { name: 'Add media' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record screen' })).toHaveCount(0)
})
