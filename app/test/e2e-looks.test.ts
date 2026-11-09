// The looks live check's offline parts (scripts/e2e/looks-lib.ts, scripts/e2e/looks.ts --dry and --selftest): the
// restyle id comparison, the literal-colour check, the catalog-hash wait, the credit ceiling and the contact sheet.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  colorProblems,
  contactSheet,
  CreditMeter,
  idProblems,
  waitForHashChange,
  type DraftComposition,
} from '../../scripts/e2e/looks-lib.js'

const repo = new URL('../..', import.meta.url).pathname
const comp = (beats: [string, string[]][]): DraftComposition => ({
  beats: beats.map(([id, texts]) => ({ id, texts: texts.map((t) => ({ id: t })) })),
  colors: {},
})
const before = comp([
  ['intro', ['intro-title']],
  ['demo', ['demo-sub']],
  ['end', ['end-cta']],
])

describe('restyle ids', () => {
  it('passes when every scene and text id is kept in order (new texts are fine)', () => {
    expect(idProblems(before, before)).toEqual([])
    expect(
      idProblems(
        before,
        comp([
          ['intro', ['intro-title', 'intro-kicker']],
          ['demo', ['demo-sub']],
          ['end', ['end-cta']],
        ]),
      ),
    ).toEqual([])
  })

  it('names every dropped, renamed or reordered id', () => {
    expect(
      idProblems(
        before,
        comp([
          ['intro', ['intro-title']],
          ['end', ['end-cta']],
        ]),
      ),
    ).toEqual(['scene "demo" is gone', 'text "demo-sub" is gone'])
    expect(
      idProblems(
        before,
        comp([
          ['intro', ['intro-title']],
          ['product', ['demo-sub']],
          ['end', ['end-cta']],
        ]),
      ),
    ).toEqual(['scene "demo" is gone', 'scene "product" is new'])
    expect(
      idProblems(
        before,
        comp([
          ['demo', ['demo-sub']],
          ['intro', ['intro-title']],
          ['end', ['end-cta']],
        ]),
      ),
    ).toEqual(['scenes were reordered: intro, demo, end became demo, intro, end'])
  })
})

describe('colours', () => {
  it('accepts literal colours and refuses expressions', () => {
    expect(colorProblems({ bg: '#0b0d10', glow: 'rgba(20, 184, 166, 0.4)', text: 'white' })).toEqual([])
    expect(
      colorProblems({ glow: 'color-mix(in srgb, #14b8a6, white 40%)', x: 'var(--va-color-bg)' }),
    ).toEqual([
      '--va-color-glow is color-mix(in srgb, #14b8a6, white 40%), not a literal colour',
      '--va-color-x is var(--va-color-bg), not a literal colour',
    ])
  })
})

describe('waiting for a look to change', () => {
  it('returns the new hash, polling on a fake clock', async () => {
    let t = 0
    const polls: [string | null, number][] = []
    const got = await waitForHashChange({
      from: 'h1',
      hash: async () => (t >= 90_000 ? 'h2' : 'h1'),
      timeoutMs: 20 * 60_000,
      intervalMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
      onPoll: (c, w) => polls.push([c, w]),
    })
    expect(got).toBe('h2')
    expect(polls).toEqual([
      ['h1', 0],
      ['h1', 30_000],
      ['h1', 60_000],
      ['h2', 90_000],
    ])
  })

  it('gives up at the timeout', async () => {
    let t = 0
    const got = await waitForHashChange({
      from: 'h1',
      hash: async () => 'h1',
      timeoutMs: 60_000,
      intervalMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
    })
    expect(got).toBeNull()
  })
})

describe('the credit ceiling', () => {
  it('refuses the next run once the running total reaches it, counting unreported runs at the estimate', () => {
    const m = new CreditMeter(300, 140)
    expect(m.canStart()).toBe(true)
    m.record(103)
    m.record(null)
    expect(m.total).toBe(243)
    expect(m.canStart()).toBe(true)
    m.record(60)
    expect(m.total).toBe(303)
    expect(m.canStart()).toBe(false)
  })
})

describe('the script', () => {
  it('makes a contact sheet from an MP4 (when ffmpeg is there)', (ctx) => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) return ctx.skip()
    const png = join(mkdtempSync(join(tmpdir(), 'looks-e2e-')), 'sheet.png')
    expect(contactSheet('ffmpeg', join(repo, 'app', 'test', 'fixtures', 'a169.mp4'), png, 2)).toBe(true)
    expect(readFileSync(png).subarray(1, 4).toString()).toBe('PNG')
    expect(contactSheet('no-such-ffmpeg', 'x.mp4', png + '2', 2)).toBe(false)
    expect(existsSync(png + '2')).toBe(false)
  })

  it('--dry prints the plan with no network and --selftest passes', () => {
    const env = {
      ...process.env,
      VIDEO_AGENT_URL: 'https://video.example.com',
      VIDEO_AGENT_KEY: 'nva_test',
      LOOKS: 'clean,kinetic',
    }
    const r = spawnSync('npx', ['tsx', 'scripts/e2e/looks.ts', '--dry'], { cwd: repo, env, encoding: 'utf8' })
    const lines = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.map((l) => l.step)).toEqual([
      'dry_env',
      ...Array(7).fill('dry_step'),
      'dry_credits',
      'DRY_OK',
    ])
    expect(lines.find((l) => l.step === 'dry_credits')).toMatchObject({
      projected: 420,
      runs: 3,
      ceiling: 700,
    })
    expect(r.stdout).not.toContain('nva_test')
    const s = spawnSync('npx', ['tsx', 'scripts/e2e/looks.ts', '--selftest'], { cwd: repo, encoding: 'utf8' })
    expect(s.status).toBe(0)
    expect(s.stdout).toContain('"selftest"')
  }, 60_000)
})
