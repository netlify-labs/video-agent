// Align to AI voice (plan 2026-11-02 §2.4, phase 6), on the mock build with its voiced composition: a file dropped on
// the Narration lane is offered Align to AI voice; the suggestion is the AI voice clip it matches, Use moves the clip
// there in one undo step, and nothing moves until it's used.
import { expect, test, type Page } from '@playwright/test'

const RATE = 24_000

/** `seconds` of syllable-like bursts in a seeded, irregular rhythm, as a mono PCM16 WAV at 24 kHz. */
function speechWav(seconds: number, seed: number): number[] {
  const n = Math.round(seconds * RATE)
  const v = new DataView(new ArrayBuffer(44 + n * 2))
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  tag(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, RATE, true)
  v.setUint32(28, RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  tag(36, 'data')
  v.setUint32(40, n * 2, true)
  let s = seed
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647
  for (let t = Math.round(0.1 * RATE); t < n;) {
    const len = Math.round((0.08 + 0.25 * r()) * RATE)
    const level = 4000 + 8000 * r()
    for (let i = 0; i < len && t + i < n; i++)
      v.setInt16(
        44 + (t + i) * 2,
        Math.round(Math.sin((2 * Math.PI * 180 * i) / RATE) * Math.sin((Math.PI * i) / len) * level),
        true,
      )
    t += len + Math.round((0.04 + 0.2 * r()) * RATE)
  }
  return [...new Uint8Array(v.buffer)]
}

async function dropOnLane(page: Page, name: string, bytes: number[], seconds: number) {
  const lane = page.locator('.va-tl-lane[data-lane="narration"]')
  await lane.scrollIntoViewIfNeeded()
  const box = await lane.boundingBox()
  const content = await page.locator('.va-tl-content').boundingBox()
  if (!box || !content) throw new Error('no Narration lane')
  const pps = Number(await page.getByTestId('timeline').getAttribute('data-px-per-sec'))
  await lane.evaluate(
    (el, a) => {
      const w = globalThis as unknown as {
        DataTransfer: new () => { items: { add: (f: unknown) => void } }
        File: new (parts: unknown[], name: string, o: { type: string }) => unknown
        DragEvent: new (type: string, o: Record<string, unknown>) => unknown
      }
      const dt = new w.DataTransfer()
      dt.items.add(new w.File([new Uint8Array(a.bytes)], a.name, { type: 'audio/wav' }))
      for (const type of ['dragenter', 'dragover', 'drop'])
        (el as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(
          new w.DragEvent(type, {
            dataTransfer: dt,
            clientX: a.x,
            clientY: a.y,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
    },
    { bytes, name, x: content.x + seconds * pps, y: box.y + box.height / 2 },
  )
}

const span = async (page: Page): Promise<[string, number, number]> => {
  const text = (await page.getByTestId('clip-inspector-span').textContent()) ?? ''
  const m = /^(\S+): ([\d.]+)–([\d.]+) s$/.exec(text)
  if (!m) throw new Error(`no span in "${text}"`)
  return [m[1] ?? '', Number(m[2]), Number(m[3])]
}

test('a dropped file matching the AI voice is aligned to it on Use, in one undo step', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockVoice', '1'))
  // The voiced fixture's stems: the intro (0.3 s in, 2.2 s) and the outro (6.2 s in, 1.5 s), each its own audio.
  const intro = speechWav(2.2, 11)
  const outro = speechWav(1.5, 23)
  await page.route('**/assets/voice/*.wav', (route) =>
    route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from(route.request().url().endsWith('outro.wav') ? outro : intro),
    }),
  )
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('narration-section')).toBeVisible()
  // The person's take of the outro, dropped at 2 s.
  await dropOnLane(page, 'outro-take.wav', outro, 2)
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
  // Unsnapped: within a pixel of 2 s.
  const dropped = await span(page)
  expect(dropped[1]).toBeCloseTo(2, 0)

  const align = page.getByTestId('narration-align')
  await align.getByRole('button', { name: 'Align to AI voice' }).click()
  await expect(page.getByTestId('narration-align-suggestion')).toHaveText('Matches the AI voice from 0:06.2')
  // Nothing moved yet.
  expect(await span(page)).toEqual(dropped)
  await align.getByRole('button', { name: 'Use' }).click()
  await expect.poll(() => span(page)).toEqual(['nar_1', 6.2, 7.7])
  await expect(page.getByTestId('narration-align')).toHaveCount(0)

  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => span(page)).toEqual(dropped)
})

test('there is no Align to AI voice without an AI voice', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('narration-section')).toBeVisible()
  await dropOnLane(page, 'take.wav', speechWav(2, 5), 1)
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('narration-align')).toHaveCount(0)
})
