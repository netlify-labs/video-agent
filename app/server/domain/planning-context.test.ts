import { describe, expect, it } from 'vitest'
import { buildContextDigest, PER_FILE_LIMIT } from './planning-context.js'

describe('planning context digest', () => {
  it('keeps only allowlisted files, labels their origin and hashes the result', () => {
    const d = buildContextDigest([
      { origin: 'brand kit', name: 'BRAND.md', text: '# Netlify brand' },
      { origin: 'context/', name: 'secrets.env', text: 'TOKEN=nope' },
      { origin: 'context/', name: 'PRODUCT.md', text: 'We sell web hosting.' },
    ])
    expect(d.sources).toEqual(['brand kitBRAND.md', 'context/PRODUCT.md'])
    expect(d.text).not.toContain('TOKEN')
    expect(d.text).toContain('## brand kitBRAND.md\n# Netlify brand')
    expect(d.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(
      buildContextDigest([{ origin: 'context/', name: 'BRAND.md', text: '# Netlify brand' }]).hash,
    ).not.toBe(d.hash)
  })
  it('cuts long files with an explicit note', () => {
    const d = buildContextDigest([
      { origin: 'context/', name: 'BRAND.md', text: 'x'.repeat(PER_FILE_LIMIT + 50) },
    ])
    expect(d.text).toContain(`[trimmed: the first ${PER_FILE_LIMIT} characters]`)
  })
})
