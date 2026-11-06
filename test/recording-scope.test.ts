// Scoped revisions of a demo (screen-recording plan §5.2; va-rsk5.3.20): redoing one recording scene may rewrite the
// kept plan and that step's cursor and hold files, never analysis.json, redact.js or another step's files; the
// prompt tells a scoped run to emit only its scenes.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/domain/prompt.js'
import { load, read } from '../src/lib/contract.js'
import { parseTrace } from '../src/lib/recording-trace.js'
import { derivedFiles, scopeFileProblems } from '../src/lib/scope.js'
import type { Analysis } from '../scripts/lib/recording-analyze.js'
import { composeDemo } from '../scripts/lib/recording-compose.js'
import { planRecording, type PlanInput } from '../scripts/lib/recording-plan.js'

const tmp = mkdtempSync(join(tmpdir(), 'va-scope-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const CASE = join(import.meta.dirname, 'fixtures', 'recording', 'plans', 'scene-change')

function demo() {
  const analysis = JSON.parse(readFileSync(join(CASE, 'analysis.json'), 'utf8')) as Analysis
  const trace = parseTrace(readFileSync(join(CASE, 'trace.json'), 'utf8'))
  const input = JSON.parse(readFileSync(join(CASE, 'input.json'), 'utf8')) as PlanInput
  const { plan } = planRecording({ mediaId: 'med_golden0001', analysis, trace, input })
  return read(load(composeDemo({ videoDir: tmp, plan, analysis, trace }).html))
}

describe('scoped revisions of a demo', () => {
  it('derives the kept plan and the scoped step files only', () => {
    const comp = demo()
    const files = derivedFiles(['step-1'], comp)
    expect(files).toEqual(
      expect.arrayContaining([
        'index.html',
        'assets/recording/plan.json',
        'assets/recording/step-1.cursor.js',
        'assets/recording/step-1.hold.jpg',
      ]),
    )
    for (const never of [
      'assets/recording/analysis.json',
      'assets/recording/redact.js',
      'assets/recording/step-2.cursor.js',
    ])
      expect(files).not.toContain(never)
    // A video without recordings derives nothing more than before.
    expect(derivedFiles(['intro'], null).some((f) => f.startsWith('assets/recording/'))).toBe(false)
  })

  it('refuses a changed redact.js, analysis.json or another step file; allows the scoped ones', () => {
    const derived = derivedFiles(['step-1'], demo())
    const parent = new Map([
      ['assets/recording/redact.js', 'a'],
      ['assets/recording/analysis.json', 'b'],
      ['assets/recording/plan.json', 'c'],
      ['assets/recording/step-1.cursor.js', 'd'],
      ['assets/recording/step-2.cursor.js', 'e'],
    ])
    const agent = new Map([
      ['assets/recording/redact.js', 'A'],
      ['assets/recording/analysis.json', 'B'],
      ['assets/recording/plan.json', 'C'],
      ['assets/recording/step-1.cursor.js', 'D'],
      ['assets/recording/step-2.cursor.js', 'E'],
    ])
    const problems = scopeFileProblems(parent, agent, derived)
    expect(problems).toEqual([
      'assets/recording/analysis.json changed; files the other scenes use must stay as they are.',
      'assets/recording/redact.js changed; files the other scenes use must stay as they are.',
      'assets/recording/step-2.cursor.js changed; files the other scenes use must stay as they are.',
    ])
  })

  it('a scoped run is told to emit only its scenes', () => {
    const p = buildPrompt({
      jobId: 'vid_d',
      attemptId: 'att_1',
      versionN: 3,
      requesterName: 'Rae',
      userPrompt: 'Redo the deploy scene slower.',
      aspect: '16:9',
      targetDurationSec: 30,
      callbackUrl: 'https://x/cb',
      checkpointUrl: 'https://x/cp',
      upload: { mode: 'blobs' },
      revision: { parentN: 2 },
      runManifestSha256: 'b'.repeat(64),
      scope: {
        n: 2,
        beats: [{ id: 'step-2', label: 'Step 2', start: 10, duration: 10 }],
        stills: false,
        voiced: false,
        locked: false,
      },
      recording: {
        mediaId: 'med_golden0001',
        file: 'assets/media/med_golden0001.mp4',
        seconds: 20,
        trace: true,
        clicks: [],
        deadlineMin: 25,
      },
    })
    expect(p).toContain(
      "emit only the scoped scenes; don't run plan again unless the request asks to re-plan them.",
    )
    expect(p).not.toContain('analyze reuses assets/recording/analysis.json')
  })
})
