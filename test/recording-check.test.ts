// recording.ts check (screen-recording plan §5.2 check; va-rsk5.3.7): a demo composed from the golden scene-change
// plan in a run-shaped root (.render/run-manifest.json, .va-run/recording/<id>/{trace,input}.json) passes; each broken
// rule fails with a message naming the scene and the rule, both through check-contract (plain and --fix) and the
// recording.ts check CLI; every fixture passes again once fixed. JSON logs { scene, rule, ok }.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { parseTrace } from '../src/lib/recording-trace.js'
import type { Analysis } from '../scripts/lib/recording-analyze.js'
import { checkContract } from '../scripts/lib/check-contract.js'
import { composeDemo } from '../scripts/lib/recording-compose.js'
import { checkRecordingScenes } from '../scripts/lib/recording-inputs.js'
import { planRecording, type PlanInput } from '../scripts/lib/recording-plan.js'

const tmp = mkdtempSync(join(tmpdir(), 'va-check-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const CASE = join(import.meta.dirname, 'fixtures', 'recording', 'plans', 'scene-change')
const ID = 'med_golden0001'
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))

let n = 0
/** A run root with the composed demo; returns paths and a reader/writer for video/ files. */
function runRoot() {
  const root = join(tmp, `r${String(n++)}`)
  const video = join(root, 'video')
  mkdirSync(join(root, '.render'), { recursive: true })
  mkdirSync(join(root, '.va-run', 'recording', ID), { recursive: true })
  mkdirSync(video, { recursive: true })
  const analysis = readJson(join(CASE, 'analysis.json')) as Analysis
  const trace = parseTrace(readFileSync(join(CASE, 'trace.json'), 'utf8'))
  const input = readJson(join(CASE, 'input.json')) as PlanInput
  const { plan } = planRecording({ mediaId: ID, analysis, trace, input })
  composeDemo({ videoDir: video, plan, analysis, trace })
  writeFileSync(join(video, 'assets', 'recording', 'analysis.json'), JSON.stringify(analysis))
  copyFileSync(join(CASE, 'trace.json'), join(root, '.va-run', 'recording', ID, 'trace.json'))
  writeFileSync(join(root, '.va-run', 'recording', ID, 'input.json'), JSON.stringify(input))
  writeFileSync(
    join(root, '.render', 'run-manifest.json'),
    JSON.stringify({ v: 1, kind: 'author', recording: { mediaId: ID, filename: `${ID}.mp4` } }),
  )
  const file = (p: string) => join(video, p)
  return {
    root,
    read: (p: string) => readFileSync(file(p), 'utf8'),
    write: (p: string, s: string) => writeFileSync(file(p), s),
  }
}

const check = (root: string) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return checkContract(root, { fix: false })
}

describe('recording.ts check', () => {
  it('passes the composed demo under plain check-contract and --fix', () => {
    const r = runRoot()
    expect(check(r.root)).toEqual({ lines: ['Contract v1: OK'], code: 0 })
    expect(checkContract(r.root, { fix: true }).code).toBe(0)
  })

  type Case = [name: string, rule: RegExp, breakIt: (r: ReturnType<typeof runRoot>) => void]
  const redact = (r: ReturnType<typeof runRoot>, f: (entries: Record<string, unknown>[]) => unknown[]) => {
    const text = r.read('assets/recording/redact.js')
    const entries = JSON.parse(text.slice('window.__vaRedact='.length, -1)) as Record<string, unknown>[]
    r.write('assets/recording/redact.js', `window.__vaRedact=${JSON.stringify(f(entries))};`)
  }
  const cursor = (r: ReturnType<typeof runRoot>, f: (text: string) => string) =>
    r.write('assets/recording/step-1.cursor.js', f(r.read('assets/recording/step-1.cursor.js')))
  const html = (r: ReturnType<typeof runRoot>, f: (text: string) => string) =>
    r.write('index.html', f(r.read('index.html')))

  const cases: Case[] = [
    ['removed locked entry', /locked-missing.*t1/, (r) => redact(r, (e) => e.slice(1))],
    [
      'shrunk box',
      /locked-changed.*s1/,
      (r) =>
        redact(r, (e) => e.map((x) => (x.id === 's1' ? { ...x, boxes: [[0, 0.8, 0.02, 0.1, 0.04]] } : x))),
    ],
    [
      'key moved by 2e-3',
      /locked-changed.*t1/,
      (r) =>
        redact(r, (e) =>
          e.map((x) =>
            x.id === 't1'
              ? {
                  ...x,
                  boxes: [
                    [0, 0.102, 0.8, 0.3, 0.05],
                    [10, 0.1, 0.6, 0.3, 0.05],
                  ],
                }
              : x,
          ),
        ),
    ],
    [
      'relabelled agent, then removed',
      /locked-missing.*t1/,
      (r) => {
        redact(r, (e) => e.filter((x) => x.id !== 't1'))
        html(r, (h) =>
          h.replace(
            `data-va-redact='[]'`,
            `data-va-redact='[{"id":"t1","origin":"agent","start":0,"end":1,"reason":"x","boxes":[[0,0.1,0.1,0.1,0.1]]}]'`,
          ),
        )
      },
    ],
    ['extra statement in a cursor file', /cursor-file/, (r) => cursor(r, (t) => `${t}window.x=1;`)],
    [
      'a function call',
      /cursor-file/,
      (r) => cursor(r, (t) => t.replace('=[[', '=(function(){return 1})()||[[')),
    ],
    ['a comment', /cursor-file/, (r) => cursor(r, (t) => `/* hi */${t}`)],
    ['a string entry', /cursor-file/, (r) => cursor(r, (t) => t.replace('=[[', '=["x",['))],
    [
      '6,001 points',
      /cursor-file/,
      (r) =>
        cursor(
          r,
          () =>
            `window.__vaCursor=window.__vaCursor||{};window.__vaCursor["step-1"]=${JSON.stringify(Array.from({ length: 6001 }, (_, i) => [Math.round((i / 6001) * 10 * 1e4) / 1e4, 0.5, 0.5]))};`,
        ),
    ],
    [
      'rate 4.1',
      /4\.1x/,
      (r) => html(r, (h) => h.replace('data-playback-rate="1"', 'data-playback-rate="4.1"')),
    ],
    [
      'rate mismatch',
      /data-playback-rate/,
      (r) => html(r, (h) => h.replace('data-playback-rate="1"', 'data-playback-rate="1.2"')),
    ],
    [
      'camera out of frame',
      /camera/,
      (r) => html(r, (h) => h.replace("data-va-camera='[[0,0.5,0.5,1]", "data-va-camera='[[0,1.5,0.5,1]")),
    ],
    [
      '65 keys',
      /65 camera keys/,
      (r) =>
        html(r, (h) =>
          h.replace(
            /data-va-camera='[^']*'/,
            `data-va-camera='${JSON.stringify(Array.from({ length: 65 }, (_, i) => [(i / 65) * 10, 0.5, 0.5, 1]))}'`,
          ),
        ),
    ],
    [
      'second video slot in the beat',
      /no other video slot/,
      (r) =>
        html(r, (h) =>
          h.replace(
            '<div class="va-cursor"',
            '<video id="v2" data-va-media="v2" data-va-kind="video" src="assets/media/x.mp4" data-start="0" data-duration="10"></video><div class="va-cursor"',
          ),
        ),
    ],
    [
      'slot shows another file',
      /slot-src/,
      (r) =>
        html(r, (h) => h.replaceAll(`src="assets/media/${ID}.mp4"`, 'src="assets/media/med_other00001.mp4"')),
    ],
  ]

  for (const [name, rule, breakIt] of cases)
    it(`refuses: ${name}`, () => {
      const r = runRoot()
      const before = r.read('index.html')
      const files = ['assets/recording/redact.js', 'assets/recording/step-1.cursor.js'].map(
        (p) => [p, r.read(p)] as const,
      )
      breakIt(r)
      const res = check(r.root)
      console.log(JSON.stringify({ test: 'recording-check', case: name, lines: res.lines }))
      expect(res.code).toBe(1)
      expect(res.lines.join('\n')).toMatch(rule)
      // Fixed again, it passes.
      r.write('index.html', before)
      for (const [p, t] of files) r.write(p, t)
      expect(check(r.root).code).toBe(0)
    })

  it('a locked box may switch between blur and solid (how it looks, not whether it hides)', () => {
    const r = runRoot()
    redact(r, (e) => e.map((x) => ({ ...x, style: 'solid' })))
    const res = check(r.root)
    console.log(JSON.stringify({ test: 'recording-check', case: 'style change', lines: res.lines }))
    expect(res.code).toBe(0)
  })

  it('a cursor file may run past in..out (the editor narrows the span without rewriting it)', () => {
    const r = runRoot()
    cursor(r, (t) => t.replace(/\]\];$/, '],[10.5,0.5,0.5]];'))
    expect(r.read('assets/recording/step-1.cursor.js')).toContain('[10.5,0.5,0.5]]')
    const res = check(r.root)
    console.log(JSON.stringify({ test: 'recording-check', case: 'cursor past out', lines: res.lines }))
    expect(res.code).toBe(0)
  })

  it('holds: refused without a still or without a voice line or retime; the camera stays inside out', () => {
    const r = runRoot()
    // Turn step-1 (0-10 s in a 10 s scene) into a held slot: 0.5x over 20 s needs a 25 s scene.
    html(r, (h) =>
      h
        .replace(
          'data-duration="10" data-va-authored-duration="10" data-track-index="0">\n  <script src="assets/recording/redact.js">',
          'data-duration="25" data-va-authored-duration="25" data-track-index="0">\n  <script src="assets/recording/redact.js">',
        )
        .replace(
          'data-playback-rate="1" muted data-start="0" data-duration="10"></video>',
          'data-playback-rate="0.5" muted data-start="0" data-duration="20" data-va-rec-hold="end"></video>\n      <img class="va-rec-hold" src="assets/recording/step-1.hold.jpg" alt="">',
        ),
    )
    const problems = () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      return checkRecordingScenes(r.root, r.read('index.html'))
        .filter((p) => p.rule === 'hold')
        .map((p) => p.message)
    }
    const msgs = problems()
    expect(msgs.join(' ')).toMatch(/only for a scene with a voice line or a retime/)
    expect(msgs.join(' ')).toMatch(/still assets\/recording\/step-1\.hold\.jpg is missing/)
    // A render-unchanged run makes the still itself, so it's pending there.
    writeFileSync(
      join(r.root, '.render', 'run-manifest.json'),
      JSON.stringify({ v: 1, kind: 'render_unchanged', recording: { mediaId: ID, filename: `${ID}.mp4` } }),
    )
    expect(problems().join(' ')).not.toMatch(/is missing/)
    // A retime (data-duration differs from the authored one) is a reason to hold.
    html(r, (h) =>
      h.replace(
        'data-duration="25" data-va-authored-duration="25"',
        'data-duration="25" data-va-authored-duration="10"',
      ),
    )
    expect(problems()).toEqual([])
  })

  it('the CLI prints one line per problem and exits 1', () => {
    const r = runRoot()
    redact(r, (e) => e.slice(1))
    const res = spawnSync('npx', ['tsx', 'scripts/recording.ts', 'check', '--root', r.root], {
      encoding: 'utf8',
    })
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/^Recording \(locked-missing\): Hidden area t1/m)
    expect(JSON.parse(res.stdout.trim().split('\n').at(-1) ?? '{}')).toMatchObject({ ok: false })
    const logs = res.stderr
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(logs).toContainEqual(
      expect.objectContaining({ step: 'recording.check', scene: '*', rule: 'locked-missing', ok: false }),
    )
  }, 60_000)
})
