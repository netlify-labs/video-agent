// app/looks/README.md is the contributor's guide (plan 2026-11-04-looks §8): every npm script it names must exist.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

describe('app/looks/README.md', () => {
  it('names only npm scripts that exist', () => {
    const scripts = Object.keys(
      (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
    )
    const named = [...read('app/looks/README.md').matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((n) => !scripts.includes(n ?? ''))).toEqual([])
  })
})

describe('README.md', () => {
  it('shows a poster for every look and links to its rules', () => {
    const ids = readdirSync(new URL('../looks/', import.meta.url), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
    const readme = read('README.md')
    for (const id of ids) {
      expect(readme, id).toContain(`src="app/looks/${id}/poster.webp"`)
      expect(readme, id).toContain(`href="app/looks/${id}/LOOK.md"`)
    }
  })
})

describe('contributing a look', () => {
  it('.github/CONTRIBUTING.md and the issue template point to app/looks/README.md', () => {
    expect(read('.github/CONTRIBUTING.md')).toContain('(../app/looks/README.md)')
    expect(read('.github/ISSUE_TEMPLATE/propose-a-look.md')).toContain('app/looks/README.md')
    expect(read('.github/ISSUE_TEMPLATE/propose-a-look.md')).toContain("labels: ['good first issue']")
  })
})
