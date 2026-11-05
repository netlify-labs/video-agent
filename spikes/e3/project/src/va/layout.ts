// The frame math (what contract-core.ts will hold): beats back to back from 0 in whole frames. Each start is the
// running, unsnapped end of the beats before it, snapped, so snapping never adds a frame per beat (contract.ts relayout).
export const FPS = 30
export const frames = (sec: number) => Math.round(sec * FPS) / FPS
/** Seconds as contract.ts writes them (to the microsecond), so both engines read back the same numbers. */
export const sec = (n: number) => Math.round(n * 1e6) / 1e6

export function layout(beats: { duration: number }[]) {
  let t = 0
  let end = 0
  const out = beats.map((b) => {
    end += b.duration
    const start = sec(t)
    const duration = sec(frames(end) - t)
    t = frames(end)
    return { start, duration, startFrame: Math.round(start * FPS), frames: Math.round(duration * FPS) }
  })
  return { beats: out, total: sec(t), totalFrames: Math.round(t * FPS) }
}
