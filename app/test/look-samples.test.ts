// The sample-render script reads its prompts from app/looks/PROMPTS.md (bead va-nifa.5.4–5.8): three, with shape and length.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { samplePrompts } from '../../scripts/e2e/look-samples.js'

describe('app/looks/PROMPTS.md', () => {
  it('has the three standard prompts, each with a shape and a length', () => {
    const prompts = samplePrompts(readFileSync(new URL('../looks/PROMPTS.md', import.meta.url), 'utf8'))
    expect(prompts.map((p) => [p.n, p.aspect, p.durationSec])).toEqual([
      [1, '16:9', 20],
      [2, '9:16', 15],
      [3, '16:9', 30],
    ])
    for (const p of prompts) expect(p.prompt).toMatch(/^A \d+-second .*Lumen/)
  })
})
