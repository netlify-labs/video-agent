// A synthetic screen recording whose right answers are known, for the recording.ts analysis tests (screen-recording
// plan §5.2, va-rsk5.3.1). 1280x720, 30 fps, H.264 with 1 s GOPs and fast start (a normalized recording), 12 s:
//   0.0-3.0  the cursor (a 24 px white square with a black border) moves from (200, 200) to (800, 400), then stops
//   3.0      it "clicks" there; 200 ms later (3.2) a card next to it changes colour
//   3.2-7.0  nothing moves (idle)
//   7.0-8.0  the cursor moves to (300, 500)
//   9.0      a scene change: the page behind it switches theme and layout
// Made with ffmpeg (lavfi drawbox/overlay only, so no font is needed), cached by path.
//   npx tsx test/fixtures/recording/make-fixture.ts <out.mp4>
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export const FIXTURE = {
  width: 1280,
  height: 720,
  fps: 30,
  seconds: 12,
  /** The cursor's centre where it stops and clicks. */
  click: { t: 3.0, x: 812, y: 412 },
  /** The card that changes 200 ms after the click. */
  card: { t: 3.2, x: 760, y: 440, w: 300, h: 150 },
  idle: { start: 3.2, end: 7.0 },
  sceneAt: 9.0,
  /** Cursor centre at time t (square's top-left + 12). */
  cursorAt(t: number): [number, number] {
    const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, Math.max(0, k))
    if (t <= 3) return [lerp(200, 800, t / 3) + 12, lerp(200, 400, t / 3) + 12]
    if (t <= 7) return [812, 412]
    if (t <= 8) return [lerp(800, 300, t - 7) + 12, lerp(400, 500, t - 7) + 12]
    return [312, 512]
  },
} as const

/** Writes the fixture to `out` unless it's there already. Throws with ffmpeg's stderr on failure. */
export function makeFixture(out: string): string {
  if (existsSync(out)) return out
  const { width: W, height: H, fps, seconds } = FIXTURE
  const page = (bg: string, panel: string, dy: number, d: number) =>
    [
      `color=c=${bg}:s=${W}x${H}:r=${fps}:d=${d}`,
      `drawbox=x=0:y=0:w=220:h=${H}:color=${panel}:t=fill`,
      `drawbox=x=220:y=0:w=${W - 220}:h=70:color=0x14b8a6:t=fill`,
      `drawbox=x=300:y=${120 + dy}:w=380:h=220:color=${panel}:t=fill`,
    ].join(',')
  const c = FIXTURE.card
  // The card changes colour 200 ms after the click and stays changed.
  const first = `${page('0xf4f5f7', '0xd1d5db', 0, FIXTURE.sceneAt)},drawbox=x=${c.x}:y=${c.y}:w=${c.w}:h=${c.h}:color=0xd1d5db:t=fill,drawbox=x=${c.x}:y=${c.y}:w=${c.w}:h=${c.h}:color=0x6366f1:t=fill:enable='gte(t,${c.t})'`
  const second = page('0x111827', '0x374151', 160, seconds - FIXTURE.sceneAt)
  // Cursor path, piecewise linear (top-left corner).
  const x = `if(lt(t,3),200+600*t/3,if(lt(t,7),800,if(lt(t,8),800-500*(t-7),300)))`
  const y = `if(lt(t,3),200+200*t/3,if(lt(t,7),400,if(lt(t,8),400+100*(t-7),500)))`
  const graph = `[0:v][1:v]concat=n=2:v=1:a=0[bg];[bg][2:v]overlay=x='${x}':y='${y}'[v]`
  const r = spawnSync(
    'ffmpeg',
    [
      ...['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', first, '-f', 'lavfi', '-i', second],
      ...['-f', 'lavfi', '-i', `color=c=white:s=24x24:r=${fps}:d=${seconds},drawbox=x=0:y=0:w=24:h=24:color=black:t=3`],
      ...['-filter_complex', graph, '-map', '[v]', '-t', String(seconds)],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', String(fps), '-keyint_min', String(fps)],
      ...['-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    ],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.slice(-800)}`)
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2]
  if (!out) throw new Error('usage: make-fixture.ts <out.mp4>')
  console.log(makeFixture(out))
}
