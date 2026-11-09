// The README's links (cli-and-sdk plan phase 6 gate; bead va-p1th.7.6): every #anchor names a heading in it, and every
// relative link points at a file or folder in the repo.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../../scripts/lib/run-tools.js'

const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
/** GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes. */
const anchor = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .trim()
    .replace(/ /g, '-')

describe('README links', () => {
  it('every #anchor is a heading', () => {
    const heads = new Set([...readme.matchAll(/^#+ (.+)$/gm)].map((m) => anchor(m[1] ?? '')))
    const links = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] ?? '')
    expect(links.length).toBeGreaterThan(0)
    expect(links.filter((l) => !heads.has(l))).toEqual([])
  })

  it('every relative link exists', () => {
    const links = [...readme.matchAll(/\]\(((?!https?:|#|mailto:)[^)\s]+)\)/g)].map(
      (m) => (m[1] ?? '').split('#')[0],
    )
    expect(links.filter((l) => l && !existsSync(join(repoRoot, l)))).toEqual([])
  })
})
