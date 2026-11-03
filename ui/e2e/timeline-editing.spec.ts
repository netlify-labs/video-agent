// Clip editing on the mock build's timeline demo (/dev/timeline): drags with snapping, trims, split, delete, the
// clip menu, nudges, and undo/redo from the keyboard, all through useNarrationEditor.
import { expect, test, type Page } from '@playwright/test'

const FRAME = 1 / 30
const clipEl = (page: Page, id: string) => page.locator(`.va-tl-clip[data-clip-id="${id}"]`)
const announcer = (page: Page) => page.getByTestId('timeline-announcer')
const summary = (page: Page) => page.getByTestId('timeline-summary')
/** The selected clip's [start, end] in seconds, from the inspector. */
const span = async (page: Page): Promise<[string, number, number]> => {
  const text = (await page.getByTestId('clip-inspector-span').textContent()) ?? ''
  const m = /^(\S+): ([\d.]+)–([\d.]+) s$/.exec(text)
  if (!m) throw new Error(`no span in "${text}"`)
  return [m[1] ?? '', Number(m[2]), Number(m[3])]
}
const pxPerSec = async (page: Page) =>
  Number(await page.getByTestId('timeline').getAttribute('data-px-per-sec'))

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/timeline')
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible()
  // Zoom in until a clip is a comfortable target, then back to the start.
  for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByTestId('timeline-scroll').evaluate((el) => {
    ;(el as unknown as { scrollLeft: number }).scrollLeft = 0
  })
  await expect(clipEl(page, 'clip_1')).toBeInViewport()
})

/** Presses on clip `id` (or one of its handles), drags by `seconds`, releases. */
async function drag(
  page: Page,
  id: string,
  seconds: number,
  opts: { part?: 'start' | 'end'; alt?: boolean } = {},
) {
  const target = opts.part ? clipEl(page, id).locator(`[data-part="${opts.part}"]`) : clipEl(page, id)
  const box = await target.boundingBox()
  if (!box) throw new Error(`no ${id}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const dx = seconds * (await pxPerSec(page))
  if (opts.alt) await page.keyboard.down('Alt')
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
}

test('editing: drag-move snaps to the neighbouring edge (Alt turns it off), undo/redo from the keyboard', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'Pointer drags are covered on desktop.')
  // clip_2 is 3.00–5.60; clip_1 ends at 2.60. Dragged 0.36 s left it lands near 2.64 and snaps to 2.60.
  await drag(page, 'clip_2', -0.36)
  await expect.poll(() => span(page)).toEqual(['clip_2', 2.6, 5.2])
  await expect(announcer(page)).toHaveText(/^Clip moved to 0:02\.60/)

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => span(page)).toEqual(['clip_2', 3, 5.6])
  await expect(announcer(page)).toHaveText(/^Undone/)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(() => span(page)).toEqual(['clip_2', 2.6, 5.2])
  await expect(announcer(page)).toHaveText(/^Redone/)
  await page.keyboard.press('ControlOrMeta+z')

  // With Alt held nothing snaps.
  await drag(page, 'clip_2', -0.36, { alt: true })
  const [, start] = await span(page)
  expect(Math.abs(start - 2.64)).toBeLessThan(0.03)
  // The whole drag is one undo step.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => span(page)).toEqual(['clip_2', 3, 5.6])
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()

  // A plain click doesn't move anything.
  await clipEl(page, 'clip_2').click()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
})

test('editing: trimming an edge moves the source bounds', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'Pointer drags are covered on desktop.')
  // clip_3 is 6.00–8.60.
  await drag(page, 'clip_3', 0.2, { part: 'end', alt: true })
  const [id, start, end] = await span(page)
  expect([id, start]).toEqual(['clip_3', 6])
  expect(Math.abs(end - 8.8)).toBeLessThan(0.03)
  await expect(announcer(page)).toHaveText(/^Clip ends at 0:08\.\d\d/)

  await drag(page, 'clip_3', 0.5, { part: 'start', alt: true })
  const [, s2, e2] = await span(page)
  expect(Math.abs(s2 - 6.5)).toBeLessThan(0.03)
  expect(e2).toBe(end)
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => span(page)).toEqual(['clip_3', 6, 8.6])
})

test('editing: S splits at the playhead (within the clip limit), Delete deletes, and both undo', async ({
  page,
}) => {
  // Seek into clip_1 (0.00–2.60) from the ruler.
  const ruler = page.getByTestId('timeline-ruler')
  const rb = await ruler.boundingBox()
  const cb = await clipEl(page, 'clip_1').boundingBox()
  if (!rb || !cb) throw new Error('no ruler')
  await ruler.click({ position: { x: cb.x - rb.x + cb.width / 2, y: rb.height / 2 } })
  await expect(summary(page)).toContainText('200 clips')

  await clipEl(page, 'clip_1').focus()
  await page.keyboard.press('Enter')
  // The fixture is at the 200-clip limit, so the split is refused, with the reason.
  await page.keyboard.press('s')
  await expect(announcer(page)).toHaveText(/^A narration can have at most 200 clips/)
  await expect(summary(page)).toContainText('200 clips')
  await clipEl(page, 'clip_4').focus()
  await page.keyboard.press('Delete')
  await expect(summary(page)).toContainText('199 clips')
  await clipEl(page, 'clip_1').focus()
  await page.keyboard.press('s')
  await expect(summary(page)).toContainText('200 clips')
  await expect(announcer(page)).toHaveText(/^Split/)
  await expect(clipEl(page, 'clip_1~2')).toBeAttached()

  // Delete the right piece; focus moves to the next clip.
  await clipEl(page, 'clip_1~2').focus()
  await page.keyboard.press('Delete')
  await expect(summary(page)).toContainText('199 clips')
  await expect(announcer(page)).toHaveText(/^Deleted/)
  await expect(clipEl(page, 'clip_1~2')).toHaveCount(0)
  await expect(clipEl(page, 'clip_2')).toBeFocused()
  await page.keyboard.press('Backspace')
  await expect(summary(page)).toContainText('198 clips')

  for (let i = 0; i < 4; i++) await page.keyboard.press('ControlOrMeta+z')
  await expect(summary(page)).toContainText('200 clips')
  await expect(clipEl(page, 'clip_4')).toBeAttached()
  await expect(clipEl(page, 'clip_1~2')).toHaveCount(0)
  await expect(clipEl(page, 'clip_2')).toBeAttached()
  await clipEl(page, 'clip_1').click()
  await expect.poll(() => span(page)).toEqual(['clip_1', 0, 2.6])
})

test('editing: arrow keys nudge the focused clip by a frame, Shift by ten', async ({ page }) => {
  await clipEl(page, 'clip_2').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await span(page))[1]).toBe(Math.round((3 + FRAME) * 100) / 100)
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(async () => (await span(page))[1]).toBe(Math.round((3 - 9 * FRAME) * 100) / 100)
  await expect(announcer(page)).toHaveText(/^Clip moved to 0:02\.70/)
  await expect(clipEl(page, 'clip_2')).toBeFocused()
})

test('editing: the clip menu mirrors the actions, from a right-click or Shift+F10', async ({ page }) => {
  await clipEl(page, 'clip_3').click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /Louder/ }).click()
  await expect(page.getByLabel('Gain (dB)')).toHaveValue('1')
  await expect(announcer(page)).toHaveText(/^Gain \+1 dB/)

  await clipEl(page, 'clip_3').click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Fade in 0.5 s' }).click()
  await expect(page.getByLabel('Fade in (s)')).toHaveValue('0.5')

  await clipEl(page, 'clip_3').click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Nudge right 10 frames' }).click()
  await expect.poll(async () => (await span(page))[1]).toBe(6.33)

  await clipEl(page, 'clip_3').click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Silence' }).click()
  await expect(page.getByLabel('Gain (dB)')).toHaveValue('')
  await expect(clipEl(page, 'clip_3')).toHaveAttribute('data-muted', '')

  // Focus is back on the clip once the menu has gone; from the keyboard, Shift+F10 opens it and Escape closes it.
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(clipEl(page, 'clip_3')).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(clipEl(page, 'clip_3')).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click()
  await expect(clipEl(page, 'clip_3')).toHaveCount(0)
  await expect(summary(page)).toContainText('199 clips')

  // Five menu actions, five undo steps.
  for (let i = 0; i < 5; i++) await page.keyboard.press('ControlOrMeta+z')
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
  await clipEl(page, 'clip_3').click()
  await expect.poll(() => span(page)).toEqual(['clip_3', 6, 8.6])
  await expect(page.getByLabel('Gain (dB)')).toHaveValue('0')
})

test('editing: typing in a field never triggers the shortcuts', async ({ page }) => {
  await clipEl(page, 'clip_2').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled()
  const gain = page.getByLabel('Gain (dB)')
  await gain.click()
  await gain.press('ControlOrMeta+a')
  await page.keyboard.type('-6')
  await expect(announcer(page)).toHaveText(/^Gain -6 dB/)
  for (const key of ['s', 'Backspace', 'Delete', 'ControlOrMeta+z', 'ArrowLeft'])
    await page.keyboard.press(key)
  await expect(summary(page)).toContainText('200 clips')
  await expect(clipEl(page, 'clip_2')).toBeAttached()
  // The nudge is still there (the field's Cmd/Ctrl+Z is the browser's, not the editor's).
  await expect.poll(async () => (await span(page))[1]).toBe(3.03)

  // Out of the field the typed gain is one undo step, then the nudge.
  await clipEl(page, 'clip_2').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(gain).toHaveValue('0')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await span(page))[1]).toBe(3)
})
