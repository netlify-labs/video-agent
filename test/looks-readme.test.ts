// looks/README.md is the contributor's guide (plan 2026-11-04-looks §8): every npm script it names must exist.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

describe('looks/README.md', () => {
  it('names only npm scripts that exist', () => {
    const scripts = Object.keys(
      (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
    )
    const named = [...read('looks/README.md').matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((n) => !scripts.includes(n ?? ''))).toEqual([])
  })
})
