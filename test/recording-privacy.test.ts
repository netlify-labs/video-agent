// Privacy mode's scan (scripts/lib/recording-privacy.ts): which frames are read, matches -> boxes, detections merged
// into candidates with keyframes and spans, and the real thing: tesseract.js over a fixture recording with known
// secrets (test/fixtures/recording/privacy/), timed. One JSON line per case.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  matchFrame,
  mergeDetections,
  sampleTimes,
  scanPrivacy,
  type Detection,
} from '../scripts/lib/recording-privacy.js'
import type { Analysis } from '../scripts/lib/recording-analyze.js'
import { SECRETS } from './fixtures/recording/privacy/make-secrets.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const FIXTURE = join(import.meta.dirname, 'fixtures', 'recording', 'privacy', 'secrets.mp4')
const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ test: 'recording-privacy', ...fields }))

describe('privacy scan', () => {
  it('reads each scene start and every 1.5 s, an idle stretch once, at most 60 frames', () => {
    const a = {
      source: { width: 1280, height: 720, fps: 30, duration: 10 },
      idle: [{ start: 4, end: 9 }],
      scenes: [6],
    }
    const t = sampleTimes(a)
    log({ case: 'sample', t })
    expect(t).toContain(6.3)
    // 4-9 s idle: read once at 4.2, not every 1.5 s.
    expect(t.filter((x) => x > 4.3 && x < 9 && x !== 6.3)).toEqual([])
    const long = sampleTimes({ ...a, source: { ...a.source, duration: 300 }, idle: [] })
    expect(long.length).toBeLessThanOrEqual(60)
  })

  it('a match covers the words it touches, padded, as frame fractions', () => {
    const line = [
      { text: 'Signed', x0: 100, y0: 50, x1: 150, y1: 70 },
      { text: 'in', x0: 155, y0: 50, x1: 170, y1: 70 },
      { text: 'as', x0: 175, y0: 50, x1: 190, y1: 70 },
      { text: 'ada@acme.dev', x0: 195, y0: 50, x1: 300, y1: 70 },
    ]
    const d = matchFrame([line], { patterns: true, strings: [], width: 1000, height: 500 })
    expect(d).toEqual([{ kind: 'email', text: 'ada@acme.dev', box: [0.191, 0.092, 0.113, 0.056] }])
    // Privacy mode off: only hide strings.
    expect(matchFrame([line], { patterns: false, strings: [], width: 1000, height: 500 })).toEqual([])
    expect(
      matchFrame([line], { patterns: false, strings: ['signed in'], width: 1000, height: 500 })[0]?.kind,
    ).toBe('string')
  })

  it('the same text in consecutive frames is one candidate; a move adds a key; spans reach the frames without it', () => {
    const email = (y: number): Detection => ({
      kind: 'email',
      text: 'ada@acme.dev',
      box: [0.2, y, 0.1, 0.05],
    })
    const c = mergeDetections(
      [
        { t: 1, found: [] },
        { t: 2, found: [email(0.1)] },
        { t: 3, found: [email(0.1)] },
        { t: 4, found: [email(0.5)] },
        { t: 5, found: [] },
      ],
      6,
    )
    log({ case: 'merge', c })
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ kind: 'email', reason: 'Privacy mode: email', start: 1, end: 5 })
    expect(c[0]?.boxes).toEqual([
      [1, 0.2, 0.1, 0.1, 0.05],
      [4, 0.2, 0.5, 0.1, 0.05],
    ])
    expect(c[0]?.preview).toBe('ad… (12 characters)')
  })

  it.runIf(hasFfmpeg)(
    "finds the fixture recording's email, key and hide string while they show, and nothing after",
    async () => {
      const analysis = {
        source: { width: 1280, height: 720, fps: 30, duration: 6 },
        idle: [],
        scenes: [3],
      } as unknown as Analysis
      const contextDir = mkdtempSync(join(tmpdir(), 'va-privacy-'))
      const r = await scanPrivacy(FIXTURE, analysis, { patterns: true, strings: [SECRETS.name], contextDir })
      log({
        case: 'fixture',
        ms: r.ms,
        frames: r.frames,
        candidates: r.candidates.map((c) => [c.kind, c.start, c.end]),
      })
      const kinds = r.candidates.map((c) => c.kind).sort()
      expect(kinds).toEqual(['email', 'key', 'string'])
      for (const c of r.candidates) {
        expect(c.start).toBe(0)
        // On screen until the page changes at 3 s: covered until the first frame without it (3.2 s), no later.
        expect(c.end).toBeGreaterThanOrEqual(3)
        expect(c.end).toBeLessThan(3.5)
      }
      // The secrets themselves never reach the file the agent reads.
      const file = readFileSync(join(contextDir, 'privacy', 'candidates.json'), 'utf8')
      for (const s of Object.values(SECRETS)) expect(file).not.toContain(s)
      // Within the budget, with room to spare at this length.
      expect(r.ms).toBeLessThan(60_000)
    },
    120_000,
  )
})
