// Align to AI voice (plan 2026-11-02 §2.4, phase 6), on the mock build with its voiced composition: a file dropped on
// the Narration lane is offered Align to AI voice; the suggestion is the AI voice clip it matches, Use moves the clip
// there in one undo step, and nothing moves until it's used.
import { expect, test } from '@playwright/test'
import { dropOnLane, pcmWav, RATE, span } from './narration-helpers.js'

/** `seconds` of syllable-like bursts in a seeded, irregular rhythm, as a mono PCM16 WAV at 24 kHz. */
function speechWav(seconds: number, seed: number): number[] {
  const n = Math.round(seconds * RATE)
  let s = seed
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647
  return pcmWav(n, RATE, (set) => {
    for (let t = Math.round(0.1 * RATE); t < n;) {
      const len = Math.round((0.08 + 0.25 * r()) * RATE)
      const level = 4000 + 8000 * r()
      for (let i = 0; i < len && t + i < n; i++)
        set(
          t + i,
          Math.round(Math.sin((2 * Math.PI * 180 * i) / RATE) * Math.sin((Math.PI * i) / len) * level),
        )
      t += len + Math.round((0.04 + 0.2 * r()) * RATE)
    }
  })
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
  await dropOnLane(page, 'outro-take.wav', outro, 2, true)
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
  await dropOnLane(page, 'take.wav', speechWav(2, 5), 1, true)
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('narration-align')).toHaveCount(0)
})
