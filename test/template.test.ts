// The template's video/ is self-contained (plan v2 §14 rule 22): the preview CSP and offline renders need every
// script, style and font to come from the folder itself.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

describe('editing contract v1 in the template', () => {
  it('the template keeps the contract, and the checker says so', async () => {
    const { validate } = await import('../src/lib/contract.js')
    const html = readFileSync(join(root, 'index.html'), 'utf8')
    const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8')) as Parameters<
      typeof validate
    >[1]
    expect(validate(html, summary)).toEqual([])
    const { execFileSync } = await import('node:child_process')
    expect(execFileSync('npx', ['tsx', 'scripts/check-contract.ts'], { encoding: 'utf8' })).toContain(
      'Contract v1: OK',
    )
  })
})

describe('AGENTS.md and the scripts it names', () => {
  const repo = join(root, '..')
  it('lists scripts/recording.ts and has the Screen recordings section', () => {
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toContain('`scripts/recording.ts`')
    const video = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(video).toContain('## Screen recordings (Video Agent)')
    expect(video).toContain('- **Recordings** (only in a demo)')
  })

  it('every script either file names exists', () => {
    for (const file of [join(repo, 'AGENTS.md'), join(root, 'AGENTS.md')]) {
      const named = [...readFileSync(file, 'utf8').matchAll(/scripts\/([a-z0-9-]+\.ts)/g)].map(
        (m) => m[1] ?? '',
      )
      for (const s of new Set(named))
        expect(existsSync(join(repo, 'scripts', s)), `${file}: scripts/${s}`).toBe(true)
    }
  })
})
