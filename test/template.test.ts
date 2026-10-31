// The template's video/ is self-contained (plan v2 §14 rule 22): the preview CSP and offline renders need every
// script, style and font to come from the folder itself.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'video')
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

describe('template video/', () => {
  it('references no external scripts, styles or fonts', () => {
    const external =
      /(?:src|href)\s*=\s*["'](?:https?:)?\/\/|@import\s+url\(\s*["']?(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\//i
    for (const f of files(root).filter((p) => /\.(html|css)$/.test(p)))
      expect(external.test(readFileSync(f, 'utf8')), f).toBe(false)
  })

  it('vendors GSAP 3.15.0', () => {
    const gsap = readFileSync(join(root, 'vendor', 'gsap.min.js'), 'utf8')
    expect(gsap.slice(0, 40)).toContain('GSAP 3.15.0')
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain(
      '<script src="vendor/gsap.min.js"></script>',
    )
  })
})
