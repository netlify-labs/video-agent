// Shared by the narration editor specs: a WAV take, and dropping it on the Narration lane.
import type { Page } from '@playwright/test'

const RATE = 24_000

/** `seconds` of a 220 Hz tone as a plain mono PCM16 WAV. */
export function toneWav(seconds: number): number[] {
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
  for (let i = 0; i < n; i++)
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * 12_000), true)
  return [...new Uint8Array(v.buffer)]
}

/** Drops a WAV on the Narration lane, at its start. */
export async function dropOnLane(page: Page, name: string, bytes: number[]) {
  const lane = page.locator('.va-tl-lane[data-lane="narration"]')
  await lane.scrollIntoViewIfNeeded()
  const box = await lane.boundingBox()
  const content = await page.locator('.va-tl-content').boundingBox()
  if (!box || !content) throw new Error('no Narration lane')
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
            bubbles: true,
            cancelable: true,
          }),
        )
    },
    { bytes, name, x: content.x + 2, y: box.y + box.height / 2 },
  )
}
