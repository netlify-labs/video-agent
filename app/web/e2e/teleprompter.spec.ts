// The teleprompter on the mock build's /dev/clock page (plan 2026-11-02 §2.1 step 3, §5.3): beside the picture (below
// it on a phone), its highlight advancing with the picture's anchors through the demo's beats (intro 0-3 s, demo
// 3-6 s, outro 6-8 s) with the next line shown dimmed before its beat, the T toggle (ignored while typing), the font
// size and the AI script. The take needs a mic: a silent stand-in (window.__vaTestMic).
import { expect, test } from '@playwright/test'

const SILENT_MIC = `
window.__vaTestMic = (ctx) => {
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  return dest.stream
}`

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: SILENT_MIC })
  await page.goto('/dev/clock')
  await page.getByRole('button', { name: /^Open the monitor/ }).click()
  await expect(page.getByRole('heading', { name: /^Monitor mix/ })).toBeVisible()
})

test('teleprompter: sits beside the picture, or below it on a phone', async ({ page }, info) => {
  await expect(page.getByTestId('prompter-layout')).toHaveAttribute(
    'data-layout',
    info.project.name === 'phone' ? 'stacked' : 'beside',
  )
  const [video, prompter] = await Promise.all([
    page.getByTestId('monitor-video').boundingBox(),
    page.getByTestId('teleprompter').boundingBox(),
  ])
  if (!video || !prompter) throw new Error('The picture and the prompter should both be on the page.')
  if (info.project.name === 'phone') expect(prompter.y).toBeGreaterThan(video.y + video.height - 1)
  else expect(prompter.x).toBeGreaterThan(video.x + video.width - 1)
})

test('teleprompter: the highlight advances with playback, the next line dimmed before its beat', async ({
  page,
}) => {
  const current = page.locator('[data-testid=teleprompter] [data-state=current]')
  await expect(current).toHaveAttribute('data-beat', 'intro')
  await page.getByRole('button', { name: 'Arm', exact: true }).click()
  await expect(page.getByTestId('monitor-phase')).toHaveText('armed', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Record with monitor' }).click()
  await expect(current).toHaveText('Org webhooks')
  // Half a second before the demo beat its line shows, dimmed, under the current intro line (checked in one frame:
  // the window is only 0.5 s long).
  const lead = await page.waitForFunction(
    `(() => {
      const next = document.querySelector('[data-state=next][data-beat=demo]')
      const cur = document.querySelector('[data-testid=teleprompter] [data-state=current]')
      return next && cur ? { current: cur.dataset.beat, opacity: Number(getComputedStyle(next).opacity) } : null
    })()`,
    undefined,
    { timeout: 10_000, polling: 'raf' },
  )
  expect(await lead.jsonValue()).toEqual({ current: 'intro', opacity: 0.5 })
  await expect(current).toHaveAttribute('data-beat', 'demo', { timeout: 5_000 })
  await expect(current).toHaveText('One subscription for every project')
  await expect(current).toHaveAttribute('data-beat', 'outro', { timeout: 5_000 })
  await page.getByRole('button', { name: 'End take' }).click()
})

test('teleprompter: T toggles it (not while typing), the font size adjusts, the AI script replaces the texts', async ({
  page,
}) => {
  const panel = page.getByTestId('teleprompter')
  await expect(panel).toHaveAttribute('data-visible', 'true')
  await page.locator('body').press('t')
  await expect(panel).toHaveAttribute('data-visible', 'false')
  await expect(panel).toContainText('Press T to show it')
  await page.locator('body').press('T')
  await expect(panel).toHaveAttribute('data-visible', 'true')
  // Typing a T in a field doesn't toggle it.
  await page.evaluate("const i = document.createElement('input'); i.id = 'typing'; document.body.append(i)")
  await page.locator('#typing').press('t')
  await expect(panel).toHaveAttribute('data-visible', 'true')

  await expect(page.getByTestId('prompter-font')).toHaveText(/^\d+px$/)
  const before = Number((await page.getByTestId('prompter-font').textContent())?.replace('px', ''))
  await page.getByRole('button', { name: 'Larger text' }).click()
  await expect(page.getByTestId('prompter-font')).toHaveText(`${before + 4}px`)

  await expect(panel).toContainText('On-screen text')
  await page.getByRole('switch', { name: 'AI script' }).check({ force: true })
  await expect(panel).toContainText('Script')
  await expect(panel.locator('[data-state=current]')).toHaveText('Webhooks for your whole organization.')
})
