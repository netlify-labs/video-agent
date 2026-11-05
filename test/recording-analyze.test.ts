// recording.ts analyze (screen-recording plan §5.2; va-rsk5.3.1) on a synthetic recording whose answers are known
// (test/fixtures/recording/make-fixture.ts): the inferred cursor within 2% of the frame at the click, the click within
// 100 ms, the idle span within 100 ms, the scene change; deterministic output; a non-normalized file refused with the
// reason; with a pointer trace, clicks from the trace; one JSON timing log per stage. Needs ffmpeg (CI installs it).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE, makeFixture } from './fixtures/recording/make-fixture.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const dir = mkdtempSync(join(tmpdir(), 'va-analyze-'))
let file = ''

/** Runs `recording.ts analyze` like a run does; returns its stdout JSON, stderr log lines and the analysis file. */
function analyze(args: string[]) {
  const out = join(dir, `analysis-${Math.random().toString(36).slice(2)}.json`)
  const r = spawnSync('npx', ['tsx', 'scripts/recording.ts', 'analyze', ...args, '--out', out], {
    encoding: 'utf8',
  })
  const logs = r.stderr
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { step: string; ms?: number })
  const result = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { ok: boolean; error?: string }
  let analysis: Record<string, any> | null = null
  try {
    analysis = JSON.parse(readFileSync(out, 'utf8')) as Record<string, any>
  } catch {
    // Refused: no file.
  }
  return { status: r.status, result, logs, analysis, out }
}

describe.runIf(hasFfmpeg)('recording.ts analyze', () => {
  beforeAll(() => {
    file = makeFixture(join(dir, 'fixture.mp4'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('finds the cursor, the click, the idle span and the scene change', () => {
    const { status, analysis, logs } = analyze(['--file', file])
    console.log(
      JSON.stringify({
        test: 'analyze',
        clicks: analysis?.clicks,
        idle: analysis?.idle,
        scenes: analysis?.scenes,
      }),
    )
    expect(status).toBe(0)
    expect(analysis).toMatchObject({
      v: 1,
      cursorSource: 'inferred',
      source: { width: 1280, height: 720, fps: 30 },
    })
    const click = analysis?.clicks?.[0] as { t: number; x: number; y: number }
    expect(analysis?.clicks).toHaveLength(1)
    expect(Math.abs(click.t - FIXTURE.click.t)).toBeLessThanOrEqual(0.1)
    expect(Math.hypot(click.x - FIXTURE.click.x, click.y - FIXTURE.click.y)).toBeLessThanOrEqual(
      0.02 * FIXTURE.width,
    )
    // The cursor path follows the drawn one while it moves.
    for (const [t, x, y] of analysis?.cursor as [number, number, number][]) {
      const [ex, ey] = FIXTURE.cursorAt(t)
      expect(Math.hypot(x - ex, y - ey), `cursor at ${t}`).toBeLessThanOrEqual(0.02 * FIXTURE.width)
    }
    const idle = (analysis?.idle as { start: number; end: number }[]).find((s) => s.start < FIXTURE.idle.end)
    expect(Math.abs((idle?.start ?? -1) - FIXTURE.idle.start)).toBeLessThanOrEqual(0.1)
    expect(Math.abs((idle?.end ?? -1) - FIXTURE.idle.end)).toBeLessThanOrEqual(0.1)
    expect(analysis?.scenes).toHaveLength(1)
    expect(Math.abs((analysis?.scenes?.[0] as number) - FIXTURE.sceneAt)).toBeLessThanOrEqual(0.1)
    for (const step of ['recording.analyze_probe', 'recording.analyze_decode', 'recording.analyze_done'])
      expect(
        logs.find((l) => l.step === step && typeof l.ms === 'number'),
        step,
      ).toBeTruthy()
  })

  it('is deterministic: the same file gives the same analysis', () => {
    const a = readFileSync(analyze(['--file', file]).out, 'utf8')
    const b = readFileSync(analyze(['--file', file]).out, 'utf8')
    expect(a).toBe(b)
  })

  it('takes the cursor and clicks from a pointer trace when there is one', () => {
    const trace = {
      v: 1,
      source: { kind: 'cli', tool: 'test', startedAt: '2026-11-05T10:00:00.000Z' },
      frame: { width: 1280, height: 720, fps: 30, duration: 12 },
      viewport: { width: 1280, height: 720, dpr: 1 },
      moves: [
        [0, 0.1, 0.1],
        [1, 0.5, 0.5],
      ],
      events: [
        { kind: 'click', t: 1.5, x: 0.25, y: 0.5, button: 0 },
        { kind: 'navigate', t: 5, path: '/settings' },
      ],
      redact: [],
    }
    const path = join(dir, 'trace.json')
    writeFileSync(path, JSON.stringify(trace))
    const { analysis } = analyze(['--file', file, '--trace', path])
    expect(analysis).toMatchObject({
      cursorSource: 'trace',
      clicks: [{ t: 1.5, x: 320, y: 360, source: 'trace' }],
    })
    // The navigation counts as a scene change next to the detected one.
    expect(analysis?.scenes).toEqual([5, 9])
  })

  it('refuses a recording that is not normalized, with the reason', () => {
    const bad = join(dir, 'gop300.mp4')
    spawnSync('ffmpeg', [
      ...['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0'],
      ...['-pix_fmt', 'yuv420p', '-movflags', '+faststart', bad],
    ])
    const { status, result, analysis } = analyze(['--file', bad])
    expect(status).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/isn't normalized: .*keyframe every second/)
    expect(analysis).toBeNull()
  })
})
