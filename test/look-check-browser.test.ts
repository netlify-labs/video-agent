// look:check's browser half (plan 2026-11-04-looks §9): a look's example through the pinned `hyperframes check` in a
// temp project. The report parsing is unit-tested; the real check runs only where a browser is present.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLookBrowser, NoBrowserError, reportProblems } from '../scripts/lib/look-browser.js'

const repoRoot = new URL('..', import.meta.url).pathname
const hyperframesVersion = (
  JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    netlifyAgent: { hyperframes: { version: string } }
  }
).netlifyAgent.hyperframes.version

describe('hyperframes check report', () => {
  it('keeps error findings only, one line each', () => {
    expect(
      reportProblems({
        ok: false,
        lint: { findings: [{ code: 'x', severity: 'warning', message: 'just a warning' }] },
        contrast: { findings: [{ code: 'contrast_aa', severity: 'error', message: 'Text fails WCAG AA.' }] },
        _meta: { version: '0.8.222' },
      }),
    ).toEqual(['hyperframes check: contrast contrast_aa: Text fails WCAG AA.'])
  })

  it('refuses a report made without a browser', () => {
    expect(() => reportProblems({ browserSkipped: true })).toThrow(NoBrowserError)
  })

  it('checks the example with video/ vendor files and config next to it', () => {
    let seen: string[] = []
    checkLookBrowser(join(repoRoot, 'looks', '_template'), {
      repoRoot,
      hyperframesVersion,
      run: (dir) => {
        seen = [
          'index.html',
          'summary.json',
          'vendor/gsap.min.js',
          'vendor/va-contract.js',
          'hyperframes.json',
        ].filter((f) => readFileSync(join(dir, f)).byteLength > 0)
        return {}
      },
    })
    expect(seen).toHaveLength(5)
  })

  it("stages the look's assets at assets/look/, where a run puts them", () => {
    let staged = false
    checkLookBrowser(join(repoRoot, 'looks', 'whiteboard'), {
      repoRoot,
      hyperframesVersion,
      run: (dir) => {
        staged = readFileSync(join(dir, 'assets', 'look', 'fonts', 'caveat-semibold.woff2')).byteLength > 0
        return {}
      },
    })
    expect(staged).toBe(true)
  })
})

/** The real check, or null (and a log line) where there's no browser. */
function realCheck(dir: string): string[] | null {
  try {
    return checkLookBrowser(dir, { repoRoot, hyperframesVersion })
  } catch (e) {
    if (!(e instanceof NoBrowserError)) throw e
    console.error(JSON.stringify({ step: 'hf-check', skipped: 'no browser' }))
    return null
  }
}

describe('hyperframes check on a look (needs a browser)', () => {
  it('passes the template and fails an example with unreadable text', (ctx) => {
    const good = realCheck(join(repoRoot, 'looks', '_template'))
    if (good === null) return ctx.skip()
    expect(good).toEqual([])

    const dir = join(mkdtempSync(join(tmpdir(), 'looks-')), 'dim')
    cpSync(join(repoRoot, 'looks', '_template'), dir, { recursive: true })
    const index = join(dir, 'example', 'index.html')
    writeFileSync(
      index,
      readFileSync(index, 'utf8').replace('--va-color-text: #f4f5f7;', '--va-color-text: #15181c;'),
    )
    const bad = realCheck(dir)
    expect(bad?.length).toBeGreaterThan(0)
    expect(bad?.[0]).toMatch(/^hyperframes check: contrast /)
  }, 120_000)
})
