// The render broker (docs/spikes.md C2; bead va-p1th.5.7): render-job, inside the agent's sandbox, asks for the render
// through files and waits; the CLI renders outside it. The CLI half is exercised by the phase 4 gate's fixture run.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brokeredRender, PROGRESS, REQUEST, RESULT, writeJson } from '../scripts/lib/render-broker.js'

const later = (ms: number, fn: () => void) => setTimeout(fn, ms)

describe('brokeredRender', () => {
  it('writes the request, reports progress, and returns when the MP4 is in place', async () => {
    const out = mkdtempSync(join(tmpdir(), 'va-render-'))
    const seen: number[] = []
    later(30, () => writeJson(join(out, PROGRESS), { pct: 40 }))
    later(80, () => writeJson(join(out, PROGRESS), { pct: 90 }))
    later(130, () => {
      writeFileSync(join(out, 'video.mp4'), 'mp4')
      writeJson(join(out, RESULT), { ok: true })
    })
    await brokeredRender(out, 'standard', (p) => seen.push(p), { pollMs: 10 })
    expect(seen).toEqual([40, 90])
    expect(JSON.parse(readFileSync(join(out, REQUEST), 'utf8'))).toEqual({ quality: 'standard' })
  })

  it("a failed render throws with the CLI's reason", async () => {
    const out = mkdtempSync(join(tmpdir(), 'va-render-'))
    later(20, () => writeJson(join(out, RESULT), { ok: false, error: 'Chrome crashed' }))
    await expect(brokeredRender(out, 'standard', () => {}, { pollMs: 10 })).rejects.toThrow(
      'The render failed: Chrome crashed',
    )
  })

  it('success without an MP4 is a failure', async () => {
    const out = mkdtempSync(join(tmpdir(), 'va-render-'))
    later(20, () => writeJson(join(out, RESULT), { ok: true }))
    await expect(brokeredRender(out, 'standard', () => {}, { pollMs: 10 })).rejects.toThrow(
      'made no video.mp4',
    )
  })

  it('gives up when no CLI answers', async () => {
    const out = mkdtempSync(join(tmpdir(), 'va-render-'))
    await expect(brokeredRender(out, 'standard', () => {}, { pollMs: 10, timeoutMs: 60 })).rejects.toThrow(
      'The CLI never finished the render',
    )
  })
})
