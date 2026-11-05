// recording.ts emit (screen-recording plan §5.2 emit, §5.3; va-rsk5.3.5): the scene markup per step (snapshot, and it
// passes the contract's recording rules), data files in their one-statement grammar, a 60 s path under 45 KB, hold
// stills only past the 0.5x floor, --holds-only idempotent, byte-identical reruns, focus stripped from an edited kept
// plan, no data-va-hold anywhere, the JSON log. Needs ffmpeg for the hold stills.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validate } from '../src/lib/contract.js'
import { parseCursorScript, parseRedactScript, type PlanV1 } from '../src/lib/recording.js'
import { parseTrace, type Trace } from '../src/lib/recording-trace.js'
import { analyzeRecording, type Analysis } from '../scripts/lib/recording-analyze.js'
import {
  emitStep,
  holdsOnly,
  lockedEntries,
  readKeptPlan,
  simplifyPath,
} from '../scripts/lib/recording-emit.js'
import { cursorPath, planRecording, stableJson, type PlanInput } from '../scripts/lib/recording-plan.js'
import { makeFixture } from './fixtures/recording/make-fixture.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const root = mkdtempSync(join(tmpdir(), 'va-emit-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const CASE = join(import.meta.dirname, 'fixtures', 'recording', 'plans', 'scene-change')
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))
const golden = () => {
  const analysis = readJson(join(CASE, 'analysis.json')) as Analysis
  const trace = parseTrace(readFileSync(join(CASE, 'trace.json'), 'utf8'))
  const input = readJson(join(CASE, 'input.json')) as PlanInput
  const { plan } = planRecording({ mediaId: 'med_golden', analysis, trace, input })
  return { analysis, trace, plan }
}

/** A composition holding just this scene, as check-contract would see it. */
const shell = (markup: string, duration: number) =>
  [
    '<!doctype html><html><head><script src="vendor/gsap.min.js"></script><script src="vendor/va-contract.js"></script>',
    '<script src="vendor/va-recording.js"></script><style>#root { --va-color-bg: #000; --va-color-text: #fff; }</style></head><body>',
    `<div id="root" data-composition-id="main" data-va-contract="1" data-start="0" data-duration="${String(duration)}" data-width="1920" data-height="1080">`,
    markup,
    '</div><script>window.__timelines["main"] = gsap.timeline({ paused: true })</script></body></html>',
  ].join('\n')

let n = 0
const freshDir = () => {
  const d = join(root, `video-${String(n++)}`)
  mkdirSync(join(d, 'assets', 'media'), { recursive: true })
  return d
}

describe('recording.ts emit', () => {
  it('emits each golden step: snapshot, valid under the contract, data files in their grammar', () => {
    const { analysis, trace, plan } = golden()
    const dir = freshDir()
    for (const step of plan.steps) {
      const r = emitStep({ videoDir: dir, plan, step: step.id, analysis, trace })
      expect(r.markup).toMatchSnapshot(step.id)
      expect(r.cursor).toBe('smooth')
      expect(validate(shell(r.markup, r.duration))).toEqual([])
      expect(r.markup).not.toContain('data-va-hold')
      expect(r.markup).not.toContain('media-start-basis')
      const cursor = parseCursorScript(
        readFileSync(join(dir, 'assets', 'recording', `${step.id}.cursor.js`), 'utf8'),
        step.id,
        step,
      )
      expect(cursor.ok).toBe(true)
    }
    const redact = parseRedactScript(readFileSync(join(dir, 'assets', 'recording', 'redact.js'), 'utf8'))
    // Every locked entry whole: the trace's and the person's, with their origin.
    expect(redact).toEqual({ ok: true, entries: lockedEntries(plan) })
    expect(lockedEntries(plan).map((e) => [e.id, e.origin])).toEqual([
      ['t1', 'trace'],
      ['s1', 'setup'],
    ])
    expect(lockedEntries(plan)[0]?.boxes).toEqual(trace.redact[0]?.boxes)
  })

  it('the grammar refuses anything but the one statement', () => {
    const ok = 'window.__vaCursor=window.__vaCursor||{};window.__vaCursor["s"]=[[0,0.5,0.5],[1,0.6,0.5]];'
    expect(parseCursorScript(ok, 's').ok).toBe(true)
    for (const bad of [
      `${ok}alert(1);`,
      ok.replace('[[0', '[[0.12345'),
      ok.replace('[1,0.6,0.5]', '[-1,0.6,0.5]'),
      ok.replace('0.6', '1.6'),
      ok.replace('["s"]', '["t"]'),
      ok.replace('[[0,0.5,0.5]', '[["0",0.5,0.5]'),
    ])
      expect(parseCursorScript(bad, 's').ok, bad).toBe(false)
    expect(parseCursorScript(ok, 's', { in: 0.5, out: 2 }).ok).toBe(false)
    expect(parseRedactScript('window.__vaRedact=[];').ok).toBe(true)
    expect(parseRedactScript('window.__vaRedact=[];fetch("x")').ok).toBe(false)
    expect(
      parseRedactScript(
        'window.__vaRedact=[{"id":"t1","origin":"agent","start":0,"end":1,"reason":"","boxes":[[0,0,0,0.1,0.1]]}];',
      ).ok,
    ).toBe(false)
  })

  it('keeps a 60 s cursor path under 45 KB after simplifying, and keeps pauses', () => {
    const moves: [number, number, number][] = []
    for (let t = 0; t <= 60; t += 1 / 60) {
      const k = Math.round(t * 1e4) / 1e4
      moves.push([k, 0.5 + 0.4 * Math.sin(k * 0.7), 0.5 + 0.35 * Math.sin(k * 1.1 + 1)])
    }
    const { analysis, trace } = golden()
    const long: Trace = { ...trace, frame: { ...trace.frame, duration: 60 }, moves }
    const a = { ...analysis, source: { ...analysis.source, duration: 60 } }
    const raw = cursorPath(a, long, 0, 60)
    const simple = simplifyPath(raw, 1280, 720)
    const bytes = `window.__vaCursor=window.__vaCursor||{};window.__vaCursor["s"]=${JSON.stringify(simple)};`
      .length
    console.log(JSON.stringify({ test: 'emit-rdp', raw: raw.length, simple: simple.length, bytes }))
    expect(bytes).toBeLessThan(45_000)
    // A still cursor then a move: the point where it starts moving is kept, so the pause stays a pause.
    const pause = simplifyPath(
      [
        [0, 0.5, 0.5],
        [1, 0.5, 0.5],
        [2, 0.5, 0.5],
        [3, 0.9, 0.5],
      ],
      1280,
      720,
    )
    expect(pause.map((p) => p[0])).toEqual([0, 2, 3])
  })

  it('refuses a scene faster than 4x, with the shortest it can be', () => {
    const { analysis, trace, plan } = golden()
    expect(() =>
      emitStep({ videoDir: freshDir(), plan, step: 'step-1', analysis, trace, duration: 2 }),
    ).toThrow(/shows 10 s of the recording, so its scene needs at least 2\.5 s/)
  })

  it('emits byte-identical files twice, and strips a focus the agent put back in the kept plan', () => {
    const { analysis, trace, plan } = golden()
    const dir = freshDir()
    const a = emitStep({ videoDir: dir, plan, step: 'step-2', analysis, trace })
    const files = a.files.map((f) => readFileSync(join(dir, f.path), 'utf8'))
    const b = emitStep({ videoDir: dir, plan, step: 'step-2', analysis, trace })
    expect(b.markup).toBe(a.markup)
    expect(b.files.map((f) => readFileSync(join(dir, f.path), 'utf8'))).toEqual(files)
    const path = join(dir, 'plan.json')
    writeFileSync(path, stableJson(plan))
    expect(readFileSync(path, 'utf8')).toContain('"focus"')
    const kept = readKeptPlan(path)
    expect(kept.steps.every((s) => s.focus === undefined)).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toContain('focus')
  })
})

describe.runIf(hasFfmpeg)('recording.ts emit: holds', () => {
  let file = ''
  let analysis: Analysis
  let plan: PlanV1
  beforeAll(async () => {
    file = makeFixture(join(root, 'fixture.mp4'))
    analysis = await analyzeRecording(file)
    plan = planRecording({ mediaId: 'med_fixture', analysis }).plan
  }, 60_000)

  const withMedia = () => {
    const dir = freshDir()
    copyFileSync(file, join(dir, 'assets', 'media', 'med_fixture.mp4'))
    return dir
  }

  it('makes a hold still only past the 0.5x floor, at the source size', () => {
    const step = plan.steps[0] as PlanV1['steps'][number]
    const span = step.out - step.in
    const dir = withMedia()
    const plain = emitStep({
      videoDir: dir,
      plan,
      step: step.id,
      analysis,
      trace: null,
      duration: span * 1.9,
    })
    expect(plain.hold).toBe(false)
    expect(existsSync(join(dir, 'assets', 'recording', `${step.id}.hold.jpg`))).toBe(false)
    expect(plain.cursor).toBe('highlight')

    const held = emitStep({ videoDir: dir, plan, step: step.id, analysis, trace: null, duration: span * 3 })
    console.log(
      JSON.stringify({
        test: 'emit-hold',
        files: held.files,
        slot: held.slotDuration,
        duration: held.duration,
      }),
    )
    expect(held.hold).toBe(true)
    expect(held.rate).toBe(0.5)
    expect(held.markup).toContain('data-va-rec-hold="end"')
    expect(held.markup).toContain(
      `<img class="va-rec-hold" src="assets/recording/${step.id}.hold.jpg" alt="">`,
    )
    expect(validate(shell(held.markup, held.duration))).toEqual([])
    const still = join(dir, 'assets', 'recording', `${step.id}.hold.jpg`)
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', still],
      {
        encoding: 'utf8',
      },
    )
    expect(probe.stdout.trim()).toBe('1280,720')
  }, 60_000)

  it('--holds-only writes the missing stills, is a no-op when none is missing, and never changes index.html', () => {
    const step = plan.steps[0] as PlanV1['steps'][number]
    const dir = withMedia()
    const held = emitStep({
      videoDir: dir,
      plan,
      step: step.id,
      analysis,
      trace: null,
      duration: (step.out - step.in) * 3,
    })
    const html = shell(held.markup, held.duration)
    writeFileSync(join(dir, 'index.html'), html)
    const still = join(dir, 'assets', 'recording', `${step.id}.hold.jpg`)
    rmSync(still, { force: true })
    expect(holdsOnly(dir).map((f) => f.path)).toEqual([`assets/recording/${step.id}.hold.jpg`])
    expect(existsSync(still)).toBe(true)
    expect(holdsOnly(dir)).toEqual([])
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(html)
  }, 60_000)

  it('CLI: prints the markup then the JSON result, and logs the emit with its files', () => {
    const dir = withMedia()
    mkdirSync(join(dir, 'assets', 'recording'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'recording', 'plan.json'), stableJson(plan))
    writeFileSync(join(dir, 'assets', 'recording', 'analysis.json'), JSON.stringify(analysis))
    const step = plan.steps[0]?.id ?? ''
    const r = spawnSync(
      'npx',
      [
        'tsx',
        'scripts/recording.ts',
        'emit',
        '--step',
        step,
        '--video',
        dir,
        '--trace',
        join(dir, 'none.json'),
      ],
      { encoding: 'utf8' },
    )
    expect(r.status).toBe(0)
    const out = r.stdout.trim().split('\n')
    expect(out[0]).toMatch(/^<section id="step-1" class="clip va-rec-scene"/)
    expect(JSON.parse(out.at(-1) ?? '{}')).toMatchObject({ ok: true, hold: false, cursor: 'highlight' })
    const logLine = r.stderr
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { step: string; planStep?: string; files?: unknown[]; ms?: number })
      .find((l) => l.step === 'recording.emit')
    expect(logLine).toMatchObject({ planStep: step, hold: null })
    expect(logLine?.files?.length).toBeGreaterThan(0)
    expect(typeof logLine?.ms).toBe('number')
  }, 60_000)
})
