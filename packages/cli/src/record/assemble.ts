// `video-agent record`'s assembly: the screencast's JPEG frames, which come
// only when the page changes, become a constant-frame-rate H.264 file with their real timings: the concat demuxer with
// a duration per frame, then fps=N. The result is a normalized recording (§4.2): a keyframe every second, fast start,
// at most 2560 px wide, even sides, no audio.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_WIDTH = 2560

export interface CapturedFrame {
  file: string
  /** Epoch seconds (the screencast's metadata.timestamp). */
  ts: number
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${String(code)}: ${err.trim().slice(-600)}`)),
    )
  })
}

/**
 * The frames on the output's frame grid: one entry per run of slots that show the same frame, with its length in
 * slots. The concat demuxer stretches a frame shorter than one output frame, so a burst of screencast frames (typing)
 * made the file longer than its trace; on the grid, every duration is a whole number of frames and the total is exact.
 */
export function onGrid(
  frames: CapturedFrame[],
  fps: number,
  stopTs: number,
): { file: string; slots: number }[] {
  const first = frames[0]
  if (!first) return []
  const total = Math.max(
    1,
    Math.round((Math.max(stopTs, (frames.at(-1) as CapturedFrame).ts + 1 / fps) - first.ts) * fps),
  )
  const runs: { file: string; slots: number }[] = []
  let i = 0
  for (let k = 0; k < total; k++) {
    // The latest frame shown by the middle of slot k.
    const t = first.ts + (k + 0.5) / fps
    while (i + 1 < frames.length && (frames[i + 1] as CapturedFrame).ts <= t) i++
    const file = (frames[i] as CapturedFrame).file
    const last = runs.at(-1)
    if (last?.file === file) last.slots++
    else runs.push({ file, slots: 1 })
  }
  return runs
}

/** Writes the recording; returns its length in seconds (a whole number of frames from the first frame to `stopTs`). */
export async function assemble(
  frames: CapturedFrame[],
  opts: { out: string; fps: number; workDir: string; stopTs: number },
): Promise<number> {
  if (!frames[0]) throw new Error('The recording has no frames: nothing changed on the page.')
  const runs = onGrid(frames, opts.fps, opts.stopTs)
  const total = runs.reduce((n, r) => n + r.slots, 0)
  const quote = (f: string) => `file '${f.replace(/'/g, "'\\''")}'`
  const lines = runs.flatMap((r) => [quote(r.file), `duration ${(r.slots / opts.fps).toFixed(6)}`])
  // The concat demuxer ignores the last duration unless the last file is listed again.
  lines.push(quote((runs.at(-1) as { file: string }).file))
  const list = join(opts.workDir, 'frames.txt')
  writeFileSync(list, `${lines.join('\n')}\n`)
  await run('ffmpeg', [
    ...['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list],
    ...[
      '-vf',
      `fps=${String(opts.fps)},scale='min(${String(MAX_WIDTH)},iw)':-2,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    ],
    ...['-frames:v', String(total)],
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'],
    ...['-g', String(opts.fps), '-keyint_min', String(opts.fps), '-sc_threshold', '0'],
    ...['-movflags', '+faststart', '-an', opts.out],
  ])
  return total / opts.fps
}
