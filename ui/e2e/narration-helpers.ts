// Shared by the narration editor specs: WAV takes, dropping one on the Narration lane, and the selected clip's span.
import type { Page } from '@playwright/test'

export const RATE = 24_000

/** `n` samples of plain mono PCM16 WAV at `rate`: silent but for what `fill` writes with `set(i, value)`. */
export function pcmWav(n: number, rate: number, fill: (set: (i: number, value: number) => void) => void) {
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
  fill((i, value) => v.setInt16(44 + i * 2, value, true))
  return [...new Uint8Array(v.buffer)]
}

/** `seconds` of a 220 Hz tone as a plain mono PCM16 WAV. */
export function toneWav(seconds: number): number[] {
  const n = Math.round(seconds * RATE)
  return pcmWav(n, RATE, (set) => {
    for (let i = 0; i < n; i++) set(i, Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * 12_000))
  })
}

/** Drops a WAV on the Narration lane: at its start, or `seconds` in (with Alt held, it doesn't snap to a scene). */
export async function dropOnLane(page: Page, name: string, bytes: number[], seconds?: number, alt = false) {
  const lane = page.locator('.va-tl-lane[data-lane="narration"]')
  await lane.scrollIntoViewIfNeeded()
  const box = await lane.boundingBox()
  const content = await page.locator('.va-tl-content').boundingBox()
  if (!box || !content) throw new Error('no Narration lane')
  const x =
    seconds === undefined
      ? content.x + 2
      : content.x + seconds * Number(await page.getByTestId('timeline').getAttribute('data-px-per-sec'))
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
    { bytes, name, alt, x, y: box.y + box.height / 2 },
  )
}

/** The selected clip's [id, start, end] in seconds, from the inspector. */
export const span = async (page: Page): Promise<[string, number, number]> => {
  const text = (await page.getByTestId('clip-inspector-span').textContent()) ?? ''
  const m = /^(\S+): ([\d.]+)–([\d.]+) s$/.exec(text)
  if (!m) throw new Error(`no span in "${text}"`)
  return [m[1] ?? '', Number(m[2]), Number(m[3])]
}
