// Fit the video to my narration in the render dialog (plan 2026-11-02 §2.5, bead va-2qq.6.4), on the mock build:
// the fit option shows its cost and the length it fits to, an overrun can switch to it, it asks once more before an
// authoring run starts, and it says when the draft's AI voice setting (Keep or Under) won't apply.
import { expect, test, type Page } from '@playwright/test'
import { toneWav } from './narration-helpers.js'

const lastRender = (page: Page) => page.evaluate<unknown>('window.__lastRender ?? null')

/** Drops a WAV on the Narration lane `seconds` in (Alt held, so it doesn't snap to a scene). */
async function dropAt(page: Page, name: string, bytes: number[], seconds: number) {
  const lane = page.locator('.va-tl-lane[data-lane="narration"]')
  await lane.scrollIntoViewIfNeeded()
  const box = await lane.boundingBox()
  const content = await page.locator('.va-tl-content').boundingBox()
  if (!box || !content) throw new Error('no Narration lane')
  const pps = Number(await page.getByTestId('timeline').getAttribute('data-px-per-sec'))
  await lane.evaluate(
    (el, a) => {
      // The browser's DOM, typed only as far as this uses it (the e2e project has no DOM lib).
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

/** A draft of the teaser's v2 with one take dropped `at` seconds in, saved. */
async function narrated(page: Page, seconds: number, at: number) {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('narration-section')).toBeVisible()
  await dropAt(page, 'my-voice.wav', toneWav(seconds), at)
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
}

test('an overrun can switch to fitting, which shows its cost, asks once more, then renders a fit', async ({
  page,
}) => {
  // 3 s of narration from 7.5 s: 1.5 s past the 9 s video; a fit ends half a second after it, at 11 s.
  await narrated(page, 3, 7.5)
  await page.getByRole('button', { name: 'Render as v3' }).click()
  const dialog = page.getByRole('dialog', { name: 'Render as v3' })
  await expect(dialog.getByRole('radio', { name: 'Keep my visuals' })).toBeChecked()
  const fit = dialog.getByRole('radio', { name: /fit the video to my narration/ })
  await expect(fit).toBeEnabled()
  await expect(dialog.getByText('An authoring run, about 250 credits', { exact: false })).toBeVisible()
  // The overrun's choices: switching to fitting picks the fit option, and the overrun no longer needs a choice.
  const overflow = dialog.getByTestId('render-overflow')
  await expect(overflow).toContainText('runs 1.5 s past the end')
  // (Choosing it closes the overrun's choices, so it's clicked rather than checked.)
  await overflow.getByRole('radio', { name: 'Switch to fitting the video to my narration' }).click()
  await expect(fit).toBeChecked()
  await expect(overflow).toHaveCount(0)
  await expect(dialog.getByTestId('render-duration-bar')).toContainText('fitted 0:11.0')
  // The draft's AI voice is Replace: nothing to say about it.
  await expect(dialog.getByTestId('render-fit-ai-voice')).toHaveCount(0)

  // Render asks once more before an authoring run starts; Back goes back without rendering.
  await dialog.getByRole('button', { name: 'Render as v3' }).click()
  const confirm = dialog.getByTestId('render-fit-confirm')
  await expect(confirm).toContainText('Start an authoring run of about 250 credits?')
  await expect(confirm).toContainText('Your narration stays exactly as it is.')
  await expect(dialog.getByRole('radio', { name: 'Keep my visuals' })).toBeDisabled()
  await confirm.getByRole('button', { name: 'Back' }).click()
  await expect(confirm).toHaveCount(0)
  expect(await page.evaluate<number>('window.__rendered ?? 0')).toBe(0)

  // Keeping the visuals again brings the overrun back, still unanswered.
  await dialog.getByRole('radio', { name: 'Keep my visuals' }).check()
  await expect(dialog.getByTestId('render-overflow')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Render as v3' })).toBeDisabled()

  await fit.check()
  await dialog.getByRole('button', { name: 'Render as v3' }).click()
  await dialog.getByRole('button', { name: 'Start fitting (about 250 credits)' }).click()
  await expect(page).toHaveURL(/\/videos\/vid_teaser$/)
  expect(await lastRender(page)).toEqual({ mode: 'fit_to_narration' })
})

test('with the AI voice on Keep, the fit option says it replaces the AI voice anyway', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockVoice', '1'))
  // Inside the video: no overrun, and a fit would shorten it to 3.5 s.
  await narrated(page, 2, 1)
  await page.getByTestId('narration-section').getByText('Keep', { exact: true }).click()
  await expect
    .poll(() => page.evaluate<unknown>('window.__lastEditOps ?? []'), { timeout: 5000 })
    .toContainEqual(
      expect.objectContaining({
        op: 'narration',
        tracks: expect.objectContaining({ aiVoice: expect.objectContaining({ mode: 'keep' }) }),
      }),
    )
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  await page.getByRole('button', { name: 'Render as v3' }).click()
  const dialog = page.getByRole('dialog', { name: 'Render as v3' })
  await expect(dialog.getByTestId('render-overflow')).toHaveCount(0)
  await expect(dialog.getByTestId('render-fit-ai-voice')).toHaveCount(0)
  await dialog.getByRole('radio', { name: /fit the video to my narration/ }).check()
  const note = dialog.getByTestId('render-fit-ai-voice')
  await expect(note).toContainText('Fitting always replaces the AI voice-over with yours')
  await expect(note).toContainText('(Keep) applies only when you keep your visuals')
  await expect(dialog.getByTestId('render-duration-bar')).toContainText('fitted 0:03.5')
  await dialog.getByRole('radio', { name: 'Keep my visuals' }).check()
  await expect(note).toHaveCount(0)
})
