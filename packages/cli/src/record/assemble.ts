// `video-agent record`'s assembly (screen-recording plan §4.6; va-rsk5.5.1): the screencast's JPEG frames, which come
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

/** Writes the recording; returns its length in seconds (first frame to `stopTs`). */
export async function assemble(
  frames: CapturedFrame[],
  opts: { out: string; fps: number; workDir: string; stopTs: number },
): Promise<number> {
  const first = frames[0]
  if (!first) throw new Error('The recording has no frames: nothing changed on the page.')
  const lines: string[] = []
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.ts ?? Math.max(opts.stopTs, f.ts + 1 / opts.fps)
    lines.push(
      `file '${f.file.replace(/'/g, "'\\''")}'`,
      `duration ${Math.max(next - f.ts, 0.001).toFixed(6)}`,
    )
  })
  // The concat demuxer ignores the last duration unless the last file is listed again.
  lines.push(`file '${(frames.at(-1) as CapturedFrame).file.replace(/'/g, "'\\''")}'`)
  const list = join(opts.workDir, 'frames.txt')
  writeFileSync(list, `${lines.join('\n')}\n`)
  await run('ffmpeg', [
    ...['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list],
    ...[
      '-vf',
      `fps=${String(opts.fps)},scale='min(${String(MAX_WIDTH)},iw)':-2,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    ],
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'],
    ...['-g', String(opts.fps), '-keyint_min', String(opts.fps), '-sc_threshold', '0'],
    ...['-movflags', '+faststart', '-an', opts.out],
  ])
  return Math.max(opts.stopTs, (frames.at(-1) as CapturedFrame).ts + 1 / opts.fps) - first.ts
}
