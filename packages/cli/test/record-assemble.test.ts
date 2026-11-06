// video-agent record's assembly (screen-recording plan §4.6; va-rsk5.5.1): the screencast's frames on the output's
// frame grid. LT-1 found a recording 2.9 s longer than its trace: a burst of frames under one output frame (typing)
// was stretched by the concat demuxer. On the grid the file is exactly as long as assemble says, which is the length
// the trace carries. The ffmpeg case needs ffmpeg (CI installs it).
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assemble, onGrid, type CapturedFrame } from '../src/record/assemble.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const frames = (ts: number[]) => ts.map((t, i) => ({ file: `f${String(i)}.jpg`, ts: 1000 + t }))

describe('onGrid', () => {
  it('maps each output frame to the latest frame shown by its middle, in runs', () => {
    expect(onGrid(frames([0, 0.1, 0.25]), 10, 1000.5)).toEqual([
      { file: 'f0.jpg', slots: 1 },
      { file: 'f1.jpg', slots: 1 },
      { file: 'f2.jpg', slots: 3 },
    ])
  })

  it('drops frames shorter than an output frame instead of stretching them; the total is exact', () => {
    // 100 frames 10 ms apart (typing), then one held until the stop: 2 s at 30 fps is 60 frames.
    const fs = frames([...Array.from({ length: 100 }, (_, i) => i * 0.01)])
    const runs = onGrid(fs, 30, 1002)
    expect(runs.reduce((n, r) => n + r.slots, 0)).toBe(60)
    expect(runs.length).toBeLessThan(40)
    expect(runs.at(-1)?.file).toBe('f99.jpg')
  })

  it('a single frame lasts until the stop, and at least one frame', () => {
    expect(onGrid(frames([0]), 30, 1001)).toEqual([{ file: 'f0.jpg', slots: 30 }])
    expect(onGrid(frames([0]), 30, 999)).toEqual([{ file: 'f0.jpg', slots: 1 }])
    expect(onGrid([], 30, 1000)).toEqual([])
  })
})

describe.runIf(hasFfmpeg)('assemble', () => {
  it('writes a file as long as it reports, with a burst of short frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-assemble-test-'))
    const jpg = (n: number) => join(dir, `f${String(n)}.jpg`)
    spawnSync('ffmpeg', [
      ...['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1'],
      ...['-frames:v', '3', join(dir, 'f%d.jpg')],
    ])
    // Like LT-1's tour A: a slow start, 120 frames of typing 8 ms apart, a pause, then two clicks.
    const ts = [0, 0.5, ...Array.from({ length: 120 }, (_, i) => 1 + i * 0.008), 3, 4.2, 4.21]
    const captured: CapturedFrame[] = ts.map((t, i) => ({ file: jpg((i % 3) + 1), ts: 2000 + t }))
    const out = join(dir, 'out.mp4')
    const seconds = await assemble(captured, { out, fps: 30, workDir: dir, stopTs: 2005.5 })
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=nb_frames:format=duration', '-of', 'json', out],
      { encoding: 'utf8' },
    )
    const info = JSON.parse(probe.stdout) as {
      streams: { nb_frames: string }[]
      format: { duration: string }
    }
    console.log(JSON.stringify({ test: 'record-assemble', seconds, probe: info }))
    expect(seconds).toBeCloseTo(5.5, 5)
    expect(Number(info.streams[0]?.nb_frames)).toBe(165)
    expect(Math.abs(Number(info.format.duration) - seconds)).toBeLessThan(1 / 30 + 1e-6)
  })
})
