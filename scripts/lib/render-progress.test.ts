import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRenderProgress, RenderProgressReporter } from './render-progress.js'

// Real `hyperframes render` output (0.8.222), progress bars and machine lines.
const fixture = readFileSync(new URL('../../app/test/fixtures/hyperframes-render.txt', import.meta.url), 'utf8')

describe('render progress', () => {
  it('reads the percent from @hf-progress lines only', () => {
    expect(parseRenderProgress('@hf-progress {"code":"capture","done":40,"total":150,"pct":45.7}')).toBe(45)
    expect(parseRenderProgress('  ██████░░  75%  Encoding video')).toBeNull()
    expect(parseRenderProgress('@hf-progress {not json')).toBeNull()
    expect(parseRenderProgress('@hf-progress {"pct":140}')).toBeNull()
  })

  it('sends rising percentages at most every 10 s, always the final 100', () => {
    let t = 0
    const sent: number[] = []
    const r = new RenderProgressReporter(
      (p) => sent.push(p),
      () => t,
    )
    for (const line of fixture.split('\n')) {
      r.line(`${line}\n`)
      t += 1500
    }
    r.line('@hf-progress {"code":"done","pct":100}\n')
    expect(sent[0]).toBe(5)
    expect(sent.at(-1)).toBe(100)
    expect([...sent].sort((a, b) => a - b)).toEqual(sent)
    expect(new Set(sent).size).toBe(sent.length)
    expect(sent.length).toBeLessThanOrEqual(6)
  })

  it('joins a line split across chunks', () => {
    const sent: number[] = []
    const r = new RenderProgressReporter(
      (p) => sent.push(p),
      () => 0,
    )
    r.line('@hf-progress {"code":"cap')
    r.line('ture","pct":30}\n')
    r.line('@hf-progress {"code":"x","pct":100}')
    r.end()
    expect(sent).toEqual([30, 100])
  })
})
