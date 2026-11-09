// recording.ts compose (screen-recording plan §5.2 compose; va-rsk5.3.6): a whole demo from a plan with no agent. The
// golden scene-change plan composes into a composition the contract accepts; its structure (beats, captions) is
// snapshotted; callouts come from focus names (escaped) or "Step N"; the Look's frame wins; the kept plan has no
// names; composing twice is byte-identical; one JSON log. The synthetic recording (no trace) composes too.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { load, read, validate } from '../server/lib/contract.js'
import { parseTrace } from '../server/lib/recording-trace.js'
import { analyzeRecording, type Analysis } from '../../scripts/lib/recording-analyze.js'
import { composeDemo } from '../../scripts/lib/recording-compose.js'
import { planRecording, type PlanInput } from '../../scripts/lib/recording-plan.js'
import { makeFixture } from './fixtures/recording/make-fixture.js'

const root = mkdtempSync(join(tmpdir(), 'va-compose-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const CASE = join(import.meta.dirname, 'fixtures', 'recording', 'plans', 'scene-change')
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))
let n = 0
const dir = () => {
  const d = join(root, `v${String(n++)}`)
  mkdirSync(d, { recursive: true })
  return d
}
const golden = () => {
  const analysis = readJson(join(CASE, 'analysis.json')) as Analysis
  const trace = parseTrace(readFileSync(join(CASE, 'trace.json'), 'utf8'))
  const { plan } = planRecording({
    mediaId: 'med_golden',
    analysis,
    trace,
    input: readJson(join(CASE, 'input.json')) as PlanInput,
  })
  return { analysis, trace, plan }
}

describe('recording.ts compose', () => {
  it('composes the golden plan into a valid demo: intro, a scene per step, outro, captions', () => {
    const { analysis, trace, plan } = golden()
    const d = dir()
    const r = composeDemo({
      videoDir: d,
      plan,
      analysis,
      trace,
      title: 'Deploy a site',
      brand: { name: 'Acme', primaryColor: '#ff5500' },
    })
    expect(validate(r.html, r.summary)).toEqual([])
    const c = read(load(r.html))
    const structure = {
      duration: c.duration,
      beats: c.beats.map((b) => ({
        id: b.id,
        label: b.label,
        start: b.start,
        duration: b.duration,
        texts: b.texts.map((x) => x.text),
        recording: b.recording ? { in: b.recording.in, out: b.recording.out, rate: b.recording.rate } : null,
      })),
      captions: r.summary.captions,
    }
    expect(structure).toMatchSnapshot()
    expect(c.beats.map((b) => b.texts.find((x) => x.id.endsWith('-callout'))?.text).filter(Boolean)).toEqual([
      'Click Import a repo',
      'Click Deploy',
    ])
    expect(r.html).toContain('--va-color-accent: #ff5500;')
    expect(readFileSync(join(d, 'assets', 'recording', 'plan.json'), 'utf8')).not.toContain('focus')
    expect(JSON.parse(readFileSync(join(d, 'summary.json'), 'utf8'))).toEqual(r.summary)
  })

  it('escapes a hostile name, falls back to "Step N", and takes the frame from the Look', () => {
    const { analysis, trace, plan } = golden()
    const named = {
      ...plan,
      steps: plan.steps.map((s, i) =>
        i === 0
          ? { ...s, focus: { role: 'button', name: '<img src=x onerror=alert(1)>' } }
          : { ...s, focus: undefined },
      ),
    }
    const r = composeDemo({
      videoDir: dir(),
      plan: named as typeof plan,
      analysis,
      trace,
      look: { frame: 'none' },
    })
    expect(r.html).toContain('Click <b>&lt;img src=x onerror=alert(1)&gt;</b>')
    expect(r.html).not.toContain('<img src=x')
    expect(r.html).toContain('>Step 2</p>')
    expect(r.html).toContain('data-va-frame="none"')
    expect(
      composeDemo({ videoDir: dir(), plan, analysis, trace, look: { frame: 'browser' } }).html,
    ).toContain('data-va-frame="wallpaper"')
  })

  it('is deterministic and logs one compose line', () => {
    const { analysis, trace, plan } = golden()
    const a = composeDemo({ videoDir: dir(), plan, analysis, trace })
    const b = composeDemo({ videoDir: dir(), plan, analysis, trace })
    expect(b.html).toBe(a.html)
    expect(b.summary).toEqual(a.summary)
    const cdir = dir()
    const planPath = join(cdir, 'full-plan.json')
    const analysisPath = join(cdir, 'analysis.json')
    writeFileSync(planPath, JSON.stringify(plan))
    writeFileSync(analysisPath, JSON.stringify(analysis))
    const r = spawnSync(
      'npx',
      [
        'tsx',
        'scripts/recording.ts',
        'compose',
        '--plan',
        planPath,
        '--analysis',
        analysisPath,
        '--video',
        cdir,
        '--look',
        'clean',
        '--trace',
        join(CASE, 'trace.json'),
      ],
      { encoding: 'utf8' },
    )
    expect(r.status, r.stderr).toBe(0)
    const logLine = r.stderr
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { step: string; ms?: number; steps?: number })
      .find((l) => l.step === 'recording.compose')
    expect(logLine).toMatchObject({ steps: 2 })
    expect(typeof logLine?.ms).toBe('number')
  }, 60_000)

  it('composes the analyzed synthetic recording (no trace: highlight ring, "Step N")', async () => {
    const analysis = await analyzeRecording(makeFixture(join(root, 'fixture.mp4')))
    const { plan } = planRecording({ mediaId: 'med_fixture', analysis })
    const r = composeDemo({ videoDir: dir(), plan, analysis, trace: null })
    expect(validate(r.html, r.summary)).toEqual([])
    expect(r.html).toContain('data-va-cursor="highlight"')
    expect(r.html).toContain('>Step 1</p>')
  }, 60_000)
})
