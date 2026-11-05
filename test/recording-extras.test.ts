// recording.ts analyze, the extras (screen-recording plan §5.2; va-rsk5.3.2): a contact sheet per scene with its
// frame times in sheets.json; a transcript only when the audio has sound (Parakeet stubbed here); the analysis reused
// for the same bytes and analyzer version and redone otherwise; context/ never in a checkpoint archive. Needs ffmpeg.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeRecording, ANALYZER_VERSION } from '../scripts/lib/recording-analyze.js'
import {
  cachedAnalysis,
  makeSheets,
  meanVolume,
  SHEETS_MAX,
  sceneSpans,
  transcribeRecording,
} from '../scripts/lib/recording-extras.js'
import { sha256File, videoTarArgs } from '../scripts/lib/run-tools.js'
import type { SttProvider } from '../scripts/lib/stt/types.js'
import { FIXTURE, makeFixture } from './fixtures/recording/make-fixture.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const dir = mkdtempSync(join(tmpdir(), 'va-extras-'))
let file = ''

/** The fixture with an audio track: a tone (sound) or silence. */
function withAudio(out: string, tone: boolean) {
  const src = tone ? 'sine=frequency=440:sample_rate=48000' : 'anullsrc=r=48000:cl=mono'
  const r = spawnSync('ffmpeg', [
    ...['-loglevel', 'error', '-y', '-i', file, '-f', 'lavfi', '-t', String(FIXTURE.seconds), '-i', src],
    ...[
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      out,
    ],
  ])
  if (r.status !== 0) throw new Error(r.stderr.toString())
  return out
}

function stubStt() {
  const calls: string[] = []
  const stt: SttProvider = {
    name: 'local',
    model: 'stub',
    transcribe(wav) {
      calls.push(wav)
      return Promise.resolve({
        words: [{ text: 'hello', start: 0.5, end: 0.9 }],
        provider: 'local',
        model: 'stub',
        durationMs: 1,
      })
    },
  }
  return { stt, calls }
}

describe.runIf(hasFfmpeg)('recording.ts analyze extras', () => {
  beforeAll(() => {
    file = makeFixture(join(dir, 'fixture.mp4'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('makes one 4x3 contact sheet per scene, 1280 wide, with each frame time in sheets.json', async () => {
    const analysis = await analyzeRecording(file)
    const out = join(dir, 'sheets')
    const started = Date.now()
    const sheets = makeSheets(file, analysis, out)
    console.log(JSON.stringify({ test: 'sheets', sheets: sheets.length, ms: Date.now() - started }))
    // The fixture has one scene change (9 s): two scenes.
    expect(sheets.map((s) => s.scene)).toEqual([
      [0, analysis.scenes[0]],
      [analysis.scenes[0], analysis.source.duration],
    ])
    const index = JSON.parse(readFileSync(join(out, 'sheets.json'), 'utf8')) as { sheets: typeof sheets }
    expect(index.sheets).toEqual(sheets)
    for (const s of sheets) {
      expect(s.times).toHaveLength(12)
      expect(s.times.every((t) => t > s.scene[0] && t < s.scene[1])).toBe(true)
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(out, s.file)],
        { encoding: 'utf8' },
      )
      // 4 tiles of 320x180 across, 3 down.
      expect(probe.stdout.trim()).toBe('1280,540')
    }
  })

  it('caps the sheets at 24 and drops scenes under half a second', () => {
    const scenes = Array.from({ length: 40 }, (_, i) => i + 1)
    expect(sceneSpans({ scenes, source: { duration: 60 } as never })).toHaveLength(SHEETS_MAX)
    expect(sceneSpans({ scenes: [5, 5.2], source: { duration: 10 } as never })).toEqual([
      [0, 5],
      [5.2, 10],
    ])
  })

  it('transcribes only when the audio has sound', async () => {
    const opts = { workDir: join(dir, 'stt'), cwd: dir, deadlineAt: Date.now() + 60_000 }
    const out = join(dir, 'transcript.json')

    const none = stubStt()
    expect(meanVolume(file)).toBeNull()
    expect(await transcribeRecording(file, out, none.stt, opts)).toBeNull()
    expect(none.calls).toHaveLength(0)
    expect(existsSync(out)).toBe(false)

    const silent = stubStt()
    expect(
      await transcribeRecording(withAudio(join(dir, 'silent.mp4'), false), out, silent.stt, opts),
    ).toBeNull()
    expect(silent.calls).toHaveLength(0)

    const speech = stubStt()
    const words = await transcribeRecording(withAudio(join(dir, 'tone.mp4'), true), out, speech.stt, opts)
    expect(words).toEqual([{ text: 'hello', start: 0.5, end: 0.9 }])
    expect(speech.calls).toHaveLength(1)
    // 16 kHz mono, as the providers expect.
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=sample_rate,channels',
        '-of',
        'csv=p=0',
        speech.calls[0] ?? '',
      ],
      { encoding: 'utf8' },
    )
    expect(probe.stdout.trim()).toBe('16000,1')
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ v: 1, provider: 'local', words })
  })

  it('reuses analysis.json for the same bytes and analyzer, and not otherwise', async () => {
    const path = join(dir, 'analysis.json')
    const sha = sha256File(file)
    expect(cachedAnalysis(path, sha)).toBeNull()
    const analysis = await analyzeRecording(file)
    writeFileSync(path, JSON.stringify(analysis))
    expect(cachedAnalysis(path, sha)).toEqual(analysis)
    // Other bytes.
    expect(cachedAnalysis(path, 'f'.repeat(64))).toBeNull()
    // Another analyzer version.
    writeFileSync(path, JSON.stringify({ ...analysis, analyzer: `${ANALYZER_VERSION}-old` }))
    expect(cachedAnalysis(path, sha)).toBeNull()
    writeFileSync(path, '{not json')
    expect(cachedAnalysis(path, sha)).toBeNull()
  })

  it('the CLI hits the cache on a second run and still makes the sheets', () => {
    const out = join(dir, 'cli-analysis.json')
    const context = join(dir, 'ctx')
    const run = () => {
      const r = spawnSync(
        'npx',
        ['tsx', 'scripts/recording.ts', 'analyze', '--file', file, '--out', out, '--context', context],
        { encoding: 'utf8' },
      )
      const logs = r.stderr
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as { step: string; hit?: boolean; ms?: number })
      return {
        status: r.status,
        result: JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>,
        logs,
      }
    }
    const first = run()
    rmSync(join(context, 'sheets'), { recursive: true, force: true })
    const second = run()
    expect(first).toMatchObject({
      status: 0,
      result: { ok: true, cached: false, sheets: 2, transcript: null },
    })
    expect(second).toMatchObject({ status: 0, result: { ok: true, cached: true, sheets: 2 } })
    expect(second.logs.some((l) => l.step === 'recording.analyze_decode')).toBe(false)
    expect(second.logs.find((l) => l.step === 'recording.sheets' && typeof l.ms === 'number')).toBeTruthy()
    expect(existsSync(join(context, 'sheets', '01.jpg'))).toBe(true)
  })

  it('never archives context/ in a checkpoint or source archive', () => {
    const out = join(dir, 'video.tgz')
    const args = videoTarArgs(out)
    const files = readFileSync(`${out}.files`, 'utf8').split('\n').filter(Boolean)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((f) => f.startsWith('video/'))).toBe(true)
    expect(args).toEqual(['-czf', out, '-C', expect.any(String), '-T', `${out}.files`])
  })
})
