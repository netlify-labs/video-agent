// The editor's Narration section and the keep-visuals render dialog (plan 2026-11-02 §2.3-§2.5), on the mock build:
// the section shows only while recorded voice-over is on; a WAV dropped on the Narration lane uploads as a narration
// take and lands as a clip where it was dropped; the clip moves and saves as the draft's narration op; Render then asks
// how, with the overflow past the end, and Hold the last frame sends holdFinalFrame. A chosen file, a recording of
// this video and library audio land at the playhead.
import { expect, test, type Page } from '@playwright/test'

const RATE = 24_000
const lastOps = (page: Page) => page.evaluate<{ op: string }[]>('window.__lastEditOps ?? []')
const lastRender = (page: Page) => page.evaluate<unknown>('window.__lastRender ?? null')
const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })

/** `seconds` of a speech-like tone (syllables at 2 Hz) as a plain mono PCM16 WAV at `rate`. */
function speechWav(seconds: number, rate = RATE): number[] {
  const n = Math.round(seconds * rate)
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
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  tag(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const syllable = Math.sin(Math.PI * 4 * t) ** 2
    v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 220 * t) * syllable * 12_000), true)
  }
  return [...new Uint8Array(v.buffer)]
}

/** Drops a WAV on the Narration lane `seconds` in (with Alt held, it doesn't snap). */
async function dropOnLane(page: Page, name: string, bytes: number[], seconds: number, alt = false) {
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
            altKey: a.alt,
            bubbles: true,
            cancelable: true,
          }),
        )
    },
    { bytes, name, alt, x: content.x + seconds * pps, y: box.y + box.height / 2 },
  )
}

/** The selected clip's [id, start, end] in seconds, from the inspector. */
const span = async (page: Page): Promise<[string, number, number]> => {
  const text = (await page.getByTestId('clip-inspector-span').textContent()) ?? ''
  const m = /^(\S+): ([\d.]+)–([\d.]+) s$/.exec(text)
  if (!m) throw new Error(`no span in "${text}"`)
  return [m[1] ?? '', Number(m[2]), Number(m[3])]
}

test('the Narration section shows while recorded voice-over is on, and not when an admin turns it off', async ({
  page,
}) => {
  await page.goto('/videos/vid_teaser/edit/2')
  const section = page.getByTestId('narration-section')
  await expect(section).toBeVisible()
  await expect(section.getByRole('region', { name: 'Timeline' })).toBeVisible()
  await expect(section.getByText('Drop an audio file here')).toBeVisible()
  await expect(section.getByRole('radio', { name: 'Light' })).toBeChecked()
  // Nothing on the track: no narration op, and Render goes straight to the render.
  await expect(page.getByTestId('edit-status')).toContainText('No changes yet')

  await mock(page, 'mockNarrationOff')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Edit v2' })).toBeVisible()
  await expect(page.getByTestId('composition-preview')).toBeVisible()
  await expect(page.getByTestId('narration-section')).toHaveCount(0)
})

test('a dropped WAV becomes a clip where it lands; moved and saved, Render asks how and holds the last frame', async ({
  page,
}) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('narration-section')).toBeVisible()
  // 4 s of narration dropped just after the 6 s scene boundary snaps to it, and runs to 10 s, past the 9 s video.
  await dropOnLane(page, 'my-voice.wav', speechWav(4), 6.04)
  const clip = page.locator('.va-tl-clip[data-clip-id="nar_1"]')
  await expect(clip).toBeVisible({ timeout: 15_000 })
  await expect(clip).toContainText('my-voice.wav')
  await expect.poll(() => span(page)).toEqual(['nar_1', 6, 10])
  await expect(page.getByTestId('narration-note')).toContainText('runs 1 s past the end')

  // Move it ten frames later from the keyboard (Shift+→).
  await clip.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => span(page)).toEqual(['nar_1', 6.33, 10.33])

  // It saves as the draft's one narration op: the uploaded take, placed in samples.
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  await expect
    .poll(async () => (await lastOps(page)).find((o) => o.op === 'narration'), { timeout: 5000 })
    .toMatchObject({
      op: 'narration',
      schema: 1,
      sampleRate: RATE,
      cleanup: 'light',
      tracks: { aiVoice: { mode: 'replace' }, music: { duck: true } },
      clips: [{ id: 'nar_1', srcStart: 0, srcEnd: 4 * RATE, start: 6 * RATE + 8000, gainDb: 0 }],
    })
  const ops = await lastOps(page)
  const mediaId = (ops.find((o) => o.op === 'narration') as unknown as { clips: { mediaId: string }[] })
    .clips[0]?.mediaId
  expect(mediaId).toMatch(/^med_mock/)
  // The take went up as a narration upload for this video, with its waveform.
  const take = await page.evaluate(async (id) => (await fetch(`/api/v1/media/${id}`)).json(), mediaId)
  expect(take).toMatchObject({
    kind: 'audio',
    recording: { role: 'narration-upload', videoId: 'vid_teaser' },
  })
  expect(await page.evaluate(async (id) => (await fetch(`/api/v1/media/${id}/peaks`)).status, mediaId)).toBe(
    200,
  )

  // Render: the dialog shows where the narration sits and the overrun, Keep my visuals chosen.
  await page.getByRole('button', { name: 'Render as v3' }).click()
  const dialog = page.getByRole('dialog', { name: 'Render as v3' })
  await expect(dialog.getByTestId('render-duration-bar')).toContainText('Narration 0:06.3–0:10.3')
  await expect(dialog.getByTestId('render-duration-bar')).toContainText('Video 0:09.0')
  await expect(dialog.getByRole('radio', { name: 'Keep my visuals' })).toBeChecked()
  await expect(dialog.getByText('About 34 credits', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('radio', { name: /fit the video to my narration/ })).toBeEnabled()
  await expect(dialog.getByTestId('render-overflow')).toContainText('runs 1.3 s past the end')
  // An overrun needs a choice before it renders.
  const go = dialog.getByRole('button', { name: 'Render as v3' })
  await expect(go).toBeDisabled()
  await dialog.getByRole('radio', { name: /Hold the last frame/ }).check()
  await expect(dialog.getByTestId('render-duration-bar')).toContainText('with the held frame 0:10.8')
  await go.click()
  await expect(page).toHaveURL(/\/videos\/vid_teaser$/)
  expect(await lastRender(page)).toEqual({ mode: 'keep_visuals', holdFinalFrame: true })
})

test('Trim in the render dialog jumps to the clip that runs over', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await dropOnLane(page, 'long.wav', speechWav(3), 7.5, true)
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  await page.getByRole('button', { name: 'Render as v3' }).click()
  await page.getByRole('button', { name: 'Trim the clip instead' }).click()
  await expect(page.getByRole('dialog', { name: 'Render as v3' })).toHaveCount(0)
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeFocused()
  expect(await page.evaluate<number>('window.__rendered ?? 0')).toBe(0)
})

test('a chosen file (decoded by the browser) and a recording of this video land at the playhead', async ({
  page,
}) => {
  await mock(page, 'mockRecordings')
  await page.goto('/videos/vid_teaser/edit/2')
  const section = page.getByTestId('narration-section')
  // A 16 kHz WAV isn't the track's rate, so it goes through decodeAudioData (resampled to 24 kHz).
  await section.locator('input[type="file"]').setInputFiles({
    name: 'phone-memo.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from(speechWav(1, 16_000)),
  })
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => span(page)).toEqual(['nar_1', 0, 1])

  await section.getByRole('button', { name: 'Add audio from' }).click()
  await page.getByRole('menuitem', { name: 'Recordings for this video' }).click()
  await page
    .getByRole('dialog', { name: 'Recordings for this video' })
    .getByRole('button', { name: 'Add Warm-up' })
    .click()
  const warm = page.locator('.va-tl-clip[data-clip-id="nar_2"]')
  await expect(warm).toContainText('Warm-up')
  // The recording's stored length (24 s), laid on top at the playhead (0), so it covers the first clip.
  await expect.poll(() => span(page)).toEqual(['nar_2', 0, 24])
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toHaveCount(0)
  await expect
    .poll(async () => (await lastOps(page)).find((o) => o.op === 'narration'), { timeout: 5000 })
    .toMatchObject({ clips: [{ id: 'nar_2', mediaId: 'med_take0003', start: 0, srcEnd: 24 * RATE }] })
})

test('library audio picked from the Narration section lands at the playhead, its full length', async ({
  page,
}) => {
  await mock(page, 'mockLibraryMusic')
  await page.goto('/videos/vid_teaser/edit/2')
  const section = page.getByTestId('narration-section')
  await section.getByRole('button', { name: 'Add audio from' }).click()
  await page.getByRole('menuitem', { name: 'The library' }).click()
  await page
    .getByRole('dialog', { name: 'Add audio to the narration' })
    .getByTestId('pick-med_libpiano')
    .click()
  const clip = page.locator('.va-tl-clip[data-clip-id="nar_1"]')
  await expect(clip).toContainText('Quiet Piano Morning')
  // No stored waveform or spans: its length is the file's (95 s in the mock), as the server checks it.
  await expect.poll(() => span(page)).toEqual(['nar_1', 0, 95])
  await expect
    .poll(async () => (await lastOps(page)).find((o) => o.op === 'narration'), { timeout: 5000 })
    .toMatchObject({ clips: [{ mediaId: 'med_libpiano', srcEnd: 95 * RATE }] })
})
