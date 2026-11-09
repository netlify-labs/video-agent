// Each track gets its own + (owner, 2026-11-06) on the mock build: Narration adds takes (Record, a file, the library,
// this video's recordings); Music sets the music bed (Find music, the library, a file), saved as a music op that the
// render keeps without an agent run; AI voice points at a revision. Add audio asks which track, and a file dropped on
// the Music lane sets the music bed.
import { expect, test, type Page } from '@playwright/test'

const lastOps = (page: Page) => page.evaluate<{ op: string }[]>('window.__lastEditOps ?? []')
const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(
    ([k, v]) => {
      localStorage.setItem(k, v)
    },
    [key, value] as const,
  )

/** A short silent WAV (the bytes are checked as audio, not listened to). */
function wav(seconds = 1, rate = 24_000): number[] {
  const n = Math.round(seconds * rate)
  const v = new DataView(new ArrayBuffer(44 + n * 2))
  const tag = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
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
  return [...new Uint8Array(v.buffer)]
}

test('the Music track’s + sets the music bed from the library: a music op, ducked under the narration', async ({
  page,
}) => {
  await mock(page, 'mockLibraryMusic')
  await page.goto('/videos/vid_teaser/edit/2')
  const music = page.locator('.va-tl-head[data-lane="music"]')
  await expect(music).toContainText('No music')
  await page.getByTestId('track-add-music').click()
  const menu = page.getByRole('menu', { name: 'Add to Music' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Find music', 'From the library', 'Upload a file'])
  await menu.getByRole('menuitem', { name: 'From the library' }).click()
  await page.getByRole('dialog', { name: 'Set the music' }).getByTestId('pick-med_libpiano').click()
  // The Music track now has the bed, with its level and Duck controls, and nothing went on the Narration track.
  await expect(music.getByRole('switch', { name: 'Duck Music under narration' })).toBeVisible()
  await expect(page.locator('.va-tl-lane[data-lane="music"] .va-tl-clip')).toHaveCount(1)
  await expect(page.locator('.va-tl-lane[data-lane="narration"] .va-tl-clip')).toHaveCount(0)
  await expect(page.getByTestId('edit-status')).toContainText('Draft saved')
  await expect
    .poll(async () => (await lastOps(page)).find((o) => o.op === 'music'), { timeout: 5000 })
    .toEqual({ op: 'music', src: 'assets/media/med_libpiano.mp3', volume: 0.5 })
  // Its level is the bed's: it saves in the same op.
  await music.getByRole('button', { name: 'Mute Music' }).click()
  await expect
    .poll(async () => (await lastOps(page)).filter((o) => o.op === 'music' || o.op === 'audio'), {
      timeout: 5000,
    })
    .toEqual([
      { op: 'music', src: 'assets/media/med_libpiano.mp3', volume: 0.5 },
      { op: 'audio', id: 'va-music', muted: true },
    ])
})

test('each track’s + offers what fits it, and Narration’s Record opens the recorder', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await page.getByTestId('track-add-narration').click()
  const narration = page.getByRole('menu', { name: 'Add to Narration' })
  await expect(narration.getByRole('menuitem')).toHaveText([
    'Record',
    'Upload a file',
    'From the library',
    'Recordings for this video',
  ])
  await narration.getByRole('menuitem', { name: 'Record', exact: true }).click()
  await expect(page.getByTestId('record-panel')).toBeVisible()
  await page.getByTestId('track-add-ai-voice').click()
  await expect(page.getByRole('menu', { name: 'Add to AI voice' }).getByRole('menuitem')).toHaveText([
    'Generate (ask for a revision with AI voice-over)',
  ])
})

test('Add audio asks which track: Music sets the bed, and the selected track is the default', async ({
  page,
}) => {
  await mock(page, 'mockLibraryMusic')
  await page.goto('/videos/vid_teaser/edit/2')
  const section = page.getByTestId('narration-section')
  await section.getByRole('button', { name: 'Add audio' }).click()
  await page.getByRole('menuitem', { name: 'From the library' }).click()
  await page.getByRole('dialog', { name: 'Add audio' }).getByTestId('pick-med_libpiano').click()
  const ask = page.getByTestId('add-to')
  // Openverse music defaults to Music.
  await expect(ask.getByRole('radio', { name: 'Music' })).toBeChecked()
  await page.getByTestId('add-to-confirm').click()
  await expect(page.locator('.va-tl-lane[data-lane="music"] .va-tl-clip')).toHaveCount(1)
  await expect(page.locator('.va-tl-lane[data-lane="narration"] .va-tl-clip')).toHaveCount(0)
  await expect
    .poll(async () => (await lastOps(page)).find((o) => o.op === 'music'), { timeout: 5000 })
    .toMatchObject({ op: 'music', src: 'assets/media/med_libpiano.mp3' })
  // A file chosen next asks too, defaulting to the track last added to (Music).
  await section.getByRole('button', { name: 'Add audio' }).click()
  await page.getByRole('menuitem', { name: 'Upload a file' }).click()
  await section
    .locator('input[type="file"]')
    .last()
    .setInputFiles({ name: 'memo.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(1)) })
  await expect(ask.getByRole('radio', { name: 'Music' })).toBeChecked()
  await ask.getByText('Narration', { exact: true }).click()
  await page.getByTestId('add-to-confirm').click()
  await expect(page.locator('.va-tl-clip[data-clip-id="nar_1"]')).toBeVisible({ timeout: 15_000 })
})

test('a file dropped on the Music lane sets the music bed', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  const lane = page.locator('.va-tl-lane[data-lane="music"]')
  await expect(lane).toContainText('Drop a music file here')
  const bytes = wav(2)
  const box = await lane.boundingBox()
  await lane.evaluate(
    (el, a) => {
      // The browser's DOM, typed only as far as this uses it (the e2e project has no DOM lib).
      const w = globalThis as unknown as {
        DataTransfer: new () => { items: { add: (f: unknown) => void } }
        File: new (parts: unknown[], name: string, o: { type: string }) => unknown
        DragEvent: new (type: string, o: Record<string, unknown>) => unknown
      }
      const dt = new w.DataTransfer()
      dt.items.add(new w.File([new Uint8Array(a.bytes)], 'theme.wav', { type: 'audio/wav' }))
      for (const type of ['dragenter', 'dragover', 'drop'])
        (el as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(
          new w.DragEvent(type, { dataTransfer: dt, clientX: a.x, bubbles: true, cancelable: true }),
        )
    },
    { bytes, x: (box?.x ?? 0) + 20 },
  )
  await expect(page.locator('.va-tl-lane[data-lane="music"] .va-tl-clip')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.locator('.va-tl-lane[data-lane="narration"] .va-tl-clip')).toHaveCount(0)
  await expect
    .poll(async () => (await lastOps(page)).find((o) => o.op === 'music'), { timeout: 10_000 })
    .toMatchObject({ op: 'music', src: expect.stringMatching(/^assets\/media\/med_mock[a-z0-9]*\.wav$/) })
})
