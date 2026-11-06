// Record in the app (screen-recording plan §4.5, path B; va-rsk5.4.7) on the mock build: a canvas stands in for the
// shared screen, encoded live with Mediabunny, uploaded, and setup opens. In Chrome: Playwright's own Chromium has no
// H.264 encoder for WebCodecs (Chrome on GitHub's runners does); where a Chrome has none either, the test skips and
// says so.
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
