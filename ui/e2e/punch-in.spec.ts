// Punch-in (plan 2026-11-02 §2.2) on the mock build: a range selected on the ruler (or the playhead and R) is
// re-recorded after a pre-roll; only the range's samples land, laid over the older clip, which is split around it
// with its samples where they were; the whole punch is one undo step. R in a text field types, it doesn't punch. The
// mic is the stand-in (window.__vaTestMic, see recorder.spec.ts for why).
import { expect, test, type Page } from '@playwright/test'
import { dropOnLane, toneWav } from './narration-helpers.js'

const RATE = 24_000

/** The stand-in mic: a 440 Hz tone gated one second on, one off (page script). */
const TEST_MIC = `
window.__vaTestMicDevices = () => [{ deviceId: 'mic-usb', label: 'USB Studio Mic' }]
window.__vaTestMic = (ctx) => {
  const osc = ctx.createOscillator()
  osc.frequency.value = 440
  const gate = ctx.createGain()
  const t = ctx.currentTime
  for (let i = 0; i < 240; i++) gate.gain.setValueAtTime(i % 2 === 0 ? 0.3 : 0, t + i)
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  osc.connect(gate).connect(dest)
  osc.start()
  return dest.stream
}`

interface Clip {
  id: string
  mediaId: string
  start: number
  srcStart: number
  srcEnd: number
}

const end = (c: Clip) => c.start + (c.srcEnd - c.srcStart)

/** The narration clips the last draft save sent, in time order. */
const savedClips = async (page: Page) => {
  const ops = await page.evaluate<{ op: string; clips?: Clip[] }[]>('window.__lastEditOps ?? []')
  return [...(ops.find((o) => o.op === 'narration')?.clips ?? [])].sort((a, b) => a.start - b.start)
}
const laneClips = (page: Page) => page.locator('.va-tl-lane[data-lane="narration"] .va-tl-clip')
const phase = (page: Page) => page.getByTestId('record-status')
const pictureTime = (page: Page) =>
  page.getByTestId('record-picture').evaluate((v) => (v as unknown as { currentTime: number }).currentTime)

/** The editor with an 8 s take at 0:00, a 1 s pre-roll, and the recorder open. */
async function setUp(page: Page) {
  await page.addInitScript({ content: TEST_MIC })
  await page.addInitScript(() => localStorage.setItem('va.narration.preRollSec', '1'))
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('narration-section')).toBeVisible()
  await dropOnLane(page, 'take.wav', toneWav(8))
  await expect(laneClips(page)).toHaveCount(1)
  await expect.poll(async () => (await savedClips(page)).length, { timeout: 15_000 }).toBe(1)
  await page.getByTestId('record-open').click()
  await expect(page.getByTestId('record-panel')).toBeVisible()
  await expect(page.getByTestId('punch-preroll')).toHaveValue('1')
}

/** Drags across the ruler from `from` to `to` seconds with Alt held (no snapping). */
async function selectRange(page: Page, from: number, to: number) {
  const ruler = page.getByTestId('timeline-ruler')
  await ruler.scrollIntoViewIfNeeded()
  const box = await ruler.boundingBox()
  const content = await page.locator('.va-tl-content').boundingBox()
  if (!box || !content) throw new Error('no ruler')
  const pps = Number(await page.getByTestId('timeline').getAttribute('data-px-per-sec'))
  const y = box.y + box.height / 2
  await page.keyboard.down('Alt')
  await page.mouse.move(content.x + from * pps, y)
  await page.mouse.down()
  await page.mouse.move(content.x + ((from + to) / 2) * pps, y, { steps: 4 })
  await page.mouse.move(content.x + to * pps, y, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
}

/** Lets the picture play past composition second `t`, then Space keeps the take and it saves. */
async function keepAfter(page: Page, t: number) {
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  await expect.poll(() => pictureTime(page), { timeout: 20_000 }).toBeGreaterThan(t)
  await page.keyboard.press('Space')
  await expect(phase(page)).toHaveAttribute('data-phase', 'saved', { timeout: 30_000 })
}

test('punch in over a ruler range: the new clip replaces exactly the range, the old clip is split around it, and undo restores it', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'Ruler drags are covered on desktop.')
  test.setTimeout(120_000)
  await setUp(page)
  const [take] = await savedClips(page)
  if (!take) throw new Error('no take')

  await selectRange(page, 2, 4)
  const punch = page.getByTestId('record-punch')
  await expect(punch).toHaveText(/Punch in 0:02\.\d to 0:0[34]\.\d/)
  const from = Number(await punch.getAttribute('data-from'))
  const to = Number(await punch.getAttribute('data-to'))
  expect(Math.abs(from - 2 * RATE)).toBeLessThan(0.1 * RATE)
  expect(Math.abs(to - 4 * RATE)).toBeLessThan(0.1 * RATE)

  await punch.click()
  await expect(phase(page)).toContainText('Punching in 0:02')
  // The picture starts the 1 s pre-roll before the punch point.
  await expect(phase(page)).toHaveAttribute('data-phase', 'recording', { timeout: 20_000 })
  expect(await pictureTime(page)).toBeLessThan(from / RATE)
  await keepAfter(page, to / RATE + 0.3)

  await expect(laneClips(page)).toHaveCount(3)
  const clips = await savedClips(page)
  expect(clips).toHaveLength(3)
  const [head, fresh, tail] = clips
  if (!head || !fresh || !tail) throw new Error('missing clips')
  expect(fresh.mediaId).not.toBe(take.mediaId)
  // The new clip covers exactly the range (its start lands on the punch point to the sample its fit allows).
  expect(Math.abs(fresh.start - from)).toBeLessThanOrEqual(1)
  expect(end(fresh)).toBe(to)
  // The old take is trimmed around it, its source untouched: each piece plays the samples it did before.
  expect(head).toMatchObject({ id: take.id, mediaId: take.mediaId, start: 0, srcStart: 0 })
  expect(end(head)).toBe(fresh.start)
  expect(tail).toMatchObject({ mediaId: take.mediaId, start: to, srcStart: to, srcEnd: take.srcEnd })
  // The whole capture is the take's source: the pre-roll (before the punch point) is kept as handle audio.
  expect(fresh.srcStart).toBeGreaterThan(3 * RATE)

  await page.keyboard.press('ControlOrMeta+z')
  await expect(laneClips(page)).toHaveCount(1)
  await expect.poll(async () => (await savedClips(page)).length, { timeout: 15_000 }).toBe(1)
  expect((await savedClips(page))[0]).toMatchObject({ id: take.id, start: 0, srcEnd: take.srcEnd })
})

test('R punches in at the playhead until stop; R typed in a field does nothing', async ({ page }) => {
  test.setTimeout(120_000)
  await setUp(page)
  const [take] = await savedClips(page)
  if (!take) throw new Error('no take')

  // Typing R in the pre-roll field is typing, not a punch.
  await page.getByTestId('punch-preroll').focus()
  await page.keyboard.press('r')
  await page.waitForTimeout(500)
  await expect(page.getByTestId('record-countdown')).toHaveCount(0)
  await expect(phase(page)).toHaveAttribute('data-phase', 'setup')

  // The playhead at about 2.5 s, from the ruler.
  const ruler = page.getByTestId('timeline-ruler')
  await ruler.scrollIntoViewIfNeeded()
  const box = await ruler.boundingBox()
  const content = await page.locator('.va-tl-content').boundingBox()
  if (!box || !content) throw new Error('no ruler')
  const pps = Number(await page.getByTestId('timeline').getAttribute('data-px-per-sec'))
  await ruler.click({ position: { x: content.x - box.x + 2.5 * pps, y: box.height / 2 } })
  const punch = page.getByTestId('record-punch')
  await expect(punch).toHaveText(/Punch in from 0:02\.\d/)
  await expect(punch).toHaveAttribute('data-to', '')
  const from = Number(await punch.getAttribute('data-from'))

  await page.keyboard.press('r')
  await expect(page.getByTestId('record-countdown')).toBeVisible()
  await keepAfter(page, from / RATE + 1.5)

  const clips = await savedClips(page)
  expect(clips).toHaveLength(3)
  const [head, fresh, tail] = clips
  if (!head || !fresh || !tail) throw new Error('missing clips')
  expect(fresh.mediaId).not.toBe(take.mediaId)
  expect(Math.abs(fresh.start - from)).toBeLessThanOrEqual(1)
  expect(end(head)).toBe(fresh.start)
  // With no end, it runs until the stop.
  expect((end(fresh) - from) / RATE).toBeGreaterThan(1.2)
  expect(tail.start).toBe(end(fresh))
  expect(tail.mediaId).toBe(take.mediaId)
})
