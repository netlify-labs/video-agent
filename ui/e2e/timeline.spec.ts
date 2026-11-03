// The narration timeline on the mock build's demo page (/dev/timeline): a ten-minute, 200-clip fixture.
import { expect, test, type Locator, type Page } from '@playwright/test'

const pxPerSec = async (page: Page) =>
  Number(await page.getByTestId('timeline').getAttribute('data-px-per-sec'))
const events = (page: Page) => page.getByTestId('timeline-events')
/** The scroll box's scrollLeft (the specs aren't typechecked against the DOM library). */
type Scroller = { scrollLeft: number; scrollWidth: number }
const scrollLeft = (l: Locator) => l.evaluate((el) => (el as unknown as Scroller).scrollLeft)

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/timeline')
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible()
})

test('timeline: four lanes with their track controls, and only the clips near the view are mounted', async ({
  page,
}) => {
  for (const lane of ['Scenes', 'Narration', 'AI voice', 'Music']) {
    await expect(page.getByRole('group', { name: `${lane} lane` })).toBeVisible()
    await expect(page.getByRole('group', { name: `${lane} track` })).toBeVisible()
  }
  await expect(page.getByRole('slider', { name: 'Narration volume' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Solo Narration' })).toBeVisible()
  await expect(page.getByRole('switch', { name: /Duck Music/ })).toBeChecked()
  await expect(page.getByRole('group', { name: 'Scenes lane' })).toContainText('Scene 1')

  // Zoomed in, the 200 clips aren't all in the DOM, and waveforms are drawn for the ones that are.
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Zoom in' }).click()
  const clips = page.getByRole('group', { name: 'Narration lane' }).getByRole('button')
  await expect.poll(() => clips.count()).toBeLessThan(200)
  expect(await clips.count()).toBeGreaterThan(0)
  await expect(page.locator('.va-tl-clip[data-tone="narration"] canvas').first()).toBeAttached()

  // Scrolled to the end, the last clip mounts and the first goes.
  await page.getByTestId('timeline-scroll').evaluate((el) => {
    const s = el as unknown as Scroller
    s.scrollLeft = s.scrollWidth
  })
  await expect(page.getByRole('button', { name: /^Narration clip 200 of 200/ })).toBeAttached()
  await expect(page.getByRole('button', { name: /^Narration clip 1 of 200/ })).toHaveCount(0)
})

test('timeline: Ctrl-scroll zooms around the pointer; a plain wheel scrolls sideways', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'Wheel zoom is a desktop gesture.')
  const scroll = page.getByTestId('timeline-scroll')
  const box = await scroll.boundingBox()
  if (!box) throw new Error('no timeline')
  const before = await pxPerSec(page)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -300)
  await page.keyboard.up('Control')
  await expect.poll(() => pxPerSec(page)).toBeGreaterThan(before * 1.5)
  const zoomed = await pxPerSec(page)
  // The ruler's labels follow the zoom.
  await expect(page.getByTestId('timeline-ruler').locator('.va-tl-tick-label').first()).toBeVisible()

  const left = await scrollLeft(scroll)
  await page.mouse.wheel(0, 200)
  await expect.poll(() => scrollLeft(scroll)).toBeGreaterThan(left)
  expect(await pxPerSec(page)).toBe(zoomed)

  await page.keyboard.down('Control')
  await page.mouse.wheel(0, 600)
  await page.keyboard.up('Control')
  await expect.poll(() => pxPerSec(page)).toBeLessThan(zoomed)
})

test('timeline: clicking the ruler seeks; dragging selects a range; arrows step frames', async ({ page }) => {
  const ruler = page.getByTestId('timeline-ruler')
  const box = await ruler.boundingBox()
  if (!box) throw new Error('no ruler')
  const pps = await pxPerSec(page)
  // Positions are fractions of the visible part of the ruler, so the spec fits the phone too.
  const view = await page.getByTestId('timeline-scroll').boundingBox()
  const at = (f: number) => Math.round((view?.width ?? 0) * f)
  await ruler.click({ position: { x: at(0.3), y: box.height / 2 } })
  const expected = at(0.3) / pps
  await expect(events(page).locator('li').first()).toHaveText(/^seek /)
  const seeked = Number((await events(page).locator('li').first().textContent())?.split(' ')[1])
  expect(Math.abs(seeked - expected)).toBeLessThan(2 / pps)
  await expect(ruler).toHaveAttribute('aria-valuenow', String(Math.round(seeked * 10) / 10))
  const playhead = page.getByTestId('timeline-playhead')
  const ph = await playhead.boundingBox()
  expect(Math.abs((ph?.x ?? 0) + 1 - (box.x + at(0.3)))).toBeLessThan(3)

  await page.mouse.move(box.x + at(0.5), box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + at(0.6), box.y + box.height / 2, { steps: 4 })
  await page.mouse.move(box.x + at(0.8), box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(events(page).locator('li').first()).toHaveText(/^range \d+\.\d\d-\d+\.\d\d$/)
  await expect(page.getByTestId('timeline-range')).toBeVisible()
  await expect(page.getByTestId('timeline-playhead-readout')).toContainText('range')

  await ruler.focus()
  await page.keyboard.press('Escape')
  await expect(events(page).locator('li').first()).toHaveText('range none')
  await expect(page.getByTestId('timeline-range')).toHaveCount(0)
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect(events(page).locator('li').first()).toHaveText('seek 0.03')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(events(page).locator('li').first()).toHaveText('seek 0.37')
})

test('timeline: track controls emit patches and reflect the new state', async ({ page }) => {
  const mute = page.getByRole('button', { name: 'Mute Narration' })
  await expect(mute).toHaveAttribute('aria-pressed', 'false')
  await mute.click()
  await expect(events(page).locator('li').first()).toHaveText('track narration {"muted":true}')
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('group', { name: 'Narration lane' })).toHaveAttribute('data-muted', '')

  await page.getByRole('button', { name: 'Solo Narration' }).click()
  await expect(events(page).locator('li').first()).toHaveText('track narration {"solo":true}')

  // The AI voice starts replaced (muted); unmuting puts it under the narration.
  const voice = page.getByRole('button', { name: 'Mute AI voice' })
  await expect(voice).toHaveAttribute('aria-pressed', 'true')
  await voice.click()
  await expect(events(page).locator('li').first()).toHaveText('track aiVoice {"mode":"under"}')

  await page.getByRole('button', { name: 'Mute Music' }).click()
  await expect(events(page).locator('li').first()).toHaveText('track musicLevel {"muted":true}')
  await page.getByRole('switch', { name: /Duck Music/ }).click({ force: true })
  await expect(events(page).locator('li').first()).toHaveText('track music {"duck":false}')
  await expect(page.getByRole('slider', { name: 'Music duck amount' })).toHaveCount(0)

  const volume = page.getByRole('slider', { name: 'Narration volume' })
  await volume.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(events(page).locator('li').first()).toHaveText('track narration {"volumeDb":-0.5}')
})

test('timeline: clips are focusable, labelled and selectable; keys go to the clip commands', async ({
  page,
}) => {
  const first = page.getByRole('button', { name: /^Narration clip 1 of 200: Take 1, 0:00\.0 to 0:02\.6$/ })
  await expect(first).toBeVisible()
  await expect(first).toHaveAttribute('tabindex', '0')
  await first.focus()
  await expect(first).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(events(page).locator('li').first()).toHaveText('select clip_1')
  await page.keyboard.press('s')
  await expect(events(page).locator('li').first()).toHaveText('command key s clip_1')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: /^Narration clip 2 of 200/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(events(page).locator('li').first()).toHaveText('select none')

  // A pointer press selects too, and reaches the commands with the part pressed.
  const second = page.getByRole('button', { name: /^Narration clip 2 of 200/ })
  await second.click()
  await expect(second).toHaveAttribute('aria-pressed', 'true')
  await expect(events(page)).toContainText('command pointer down clip_2')
  await expect(events(page)).toContainText('command pointer up clip_2')
})
