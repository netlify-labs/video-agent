// The editor's recording panels, pure parts (lib/recording-edit.ts): each kind of change makes its own op and nothing
// else, the speed notes, Auto keeps the planner's keys inside the span, and a camera key set at a moment stays inside
// the frame.
import { describe, expect, it } from 'vitest'
import {
  autoCamera,
  noZoom,
  recordingOps,
  setCameraKey,
  speedNote,
  speedOf,
  type Composition,
  type RecordingBeat,
} from './recording-edit'

const rec: RecordingBeat = {
  step: 'add-site',
  slot: 'add-site-screen',
  src: 'assets/media/med_rec.mp4',
  in: 2,
  out: 12,
  rate: 1.3333,
  crop: null,
  camera: [
    [2, 0.5, 0.5, 1],
    [3.4, 0.6, 0.31, 1.9, 'power2.inOut'],
  ],
  cursor: { style: 'smooth', size: 1, path: 'add-site' },
  clicks: [[4, 0.611, 0.304]],
  redact: [],
  locked: 'assets/recording/redact.js',
  hold: null,
}
const comp = (r: RecordingBeat) =>
  ({
    beats: [
      {
        id: 'add-site',
        start: 2.5,
        duration: 7.5,
        authoredDuration: 7.5,
        label: null,
        texts: [],
        media: [],
        voice: null,
        recording: r,
      },
    ],
  }) as unknown as Composition

describe('recording panel ops', () => {
  it('each change makes its own op, and nothing changed makes none', () => {
    expect(recordingOps(comp(rec), comp(rec))).toEqual([])
    const ops = recordingOps(
      comp(rec),
      comp({
        ...rec,
        in: 2.5,
        camera: noZoom({ in: 2.5 }),
        cursor: { ...rec.cursor, style: 'highlight' },
        redact: [
          { id: 'e1', origin: 'editor', start: 2.5, end: 12, reason: '', boxes: [[2.5, 0.1, 0.1, 0.2, 0.1]] },
        ],
      }),
    )
    expect(ops.map((o) => o.op)).toEqual(['span', 'camera', 'cursor', 'redact'])
    expect(ops[0]).toEqual({ op: 'span', beat: 'add-site', in: 2.5, out: 12 })
  })

  it("a setup box's new span is a boxSpan op; the same span is none", () => {
    const withBoxes = (end: number) =>
      ({ ...comp(rec), setupBoxes: [{ id: 's1', start: 0, end }] }) as unknown as Composition
    expect(recordingOps(withBoxes(20), withBoxes(20))).toEqual([])
    expect(recordingOps(withBoxes(20), withBoxes(8.5))).toEqual([
      { op: 'boxSpan', id: 's1', start: 0, end: 8.5 },
    ])
  })

  it('speed: amber over 2x, a hold under 0.5x, refused past 4x', () => {
    expect(speedOf(rec, 7.5)).toBe(1.33)
    expect(speedNote(1.33).tone).toBe('ok')
    expect(speedNote(2.4).tone).toBe('warn')
    expect(speedNote(0.3).text).toMatch(/holds/)
    expect(speedNote(6).tone).toBe('bad')
  })

  it('Auto keeps the planner keys inside the span; a key set at a moment stays inside the frame', () => {
    const plan = [
      [0, 0.5, 0.5, 1],
      [3.4, 0.6, 0.31, 1.9, 'power2.inOut'],
      [10.9, 0.6, 0.31, 1.9],
    ]
    expect(autoCamera(plan, { in: 3, out: 9 })).toEqual([
      [3, expect.any(Number), expect.any(Number), expect.any(Number)],
      [3.4, 0.6, 0.31, 1.9, 'power2.inOut'],
    ])
    // Zoom 2 at x=0.95 would show past the right edge: the centre comes back to 0.75.
    const keys = setCameraKey(rec.camera, 5, 0.95, 0.5, 2) as number[][]
    expect(keys.at(-1)?.slice(0, 4)).toEqual([5, 0.75, 0.5, 2])
    // Setting the key at an existing moment changes that key.
    expect((setCameraKey(rec.camera, 2, 0.5, 0.5, 1.5) as number[][]).length).toBe(2)
  })
})
