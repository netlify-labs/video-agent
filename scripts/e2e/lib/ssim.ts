// Frame sampling and SSIM with ffmpeg, for checking that frozen scenes still look the same after a scoped revision
// (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §10; spike B2 in docs/spikes.md sets the threshold).
import { execFileSync, spawnSync } from 'node:child_process'

/** Writes the frame of `mp4` shown at `atSec` to `out` (PNG or JPEG by extension). */
export function sampleFrame(mp4: string, atSec: number, out: string) {
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    Math.max(0, atSec).toFixed(3),
    '-i',
    mp4,
    '-frames:v',
    '1',
    out,
  ])
}

/** An image's width and height, from ffprobe (a missing or unreadable file fails like the comparison would). */
function sizeOf(image: string): { w: number; h: number } {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      image,
    ],
    { encoding: 'utf8' },
  )
  const [w, h] = r.stdout.trim().split(',').map(Number)
  if (r.status !== 0 || !w || !h)
    throw new Error(`ffmpeg ssim failed: no picture size for ${image}: ${r.stderr.slice(-400)}`)
  return { w, h }
}

/**
 * The SSIM ("All", 0–1) of two images; `b` is scaled to `a`'s size first, so different sizes still compare. A plain
 * scale to `a`'s probed size, not scale2ref: FFmpeg 7.0's scale2ref encodes nothing for two still images (the static
 * build CI and runs use).
 */
export function ssim(a: string, b: string): number {
  const { w, h } = sizeOf(a)
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-i', a, '-i', b, '-lavfi', `[1:v]scale=${w}:${h}[b];[0:v][b]ssim`, '-f', 'null', '-'],
    { encoding: 'utf8' },
  )
  const m = /SSIM .*All:([0-9.]+)/.exec(r.stderr)
  if (r.status !== 0 || !m?.[1]) throw new Error(`ffmpeg ssim failed: ${r.stderr.slice(-400)}`)
  return Number(m[1])
}

/**
 * The lowest SSIM over an n×n grid of tiles. A small change (one line of text) barely moves a whole frame's SSIM,
 * which honest re-encodes also move, but it stands out in its own tile (spike B2, docs/spikes.md).
 */
export function tileSsim(a: string, b: string, n = 4): number {
  let min = 1
  const { w, h } = sizeOf(a)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const crop = `crop=iw/${n}:ih/${n}:iw*${x}/${n}:ih*${y}/${n}`
      const r = spawnSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-i',
          a,
          '-i',
          b,
          '-lavfi',
          `[1:v]scale=${w}:${h}[b];[0:v]${crop}[ta];[b]${crop}[tb];[ta][tb]ssim`,
          '-f',
          'null',
          '-',
        ],
        { encoding: 'utf8' },
      )
      const m = /SSIM .*All:([0-9.]+)/.exec(r.stderr)
      if (r.status !== 0 || !m?.[1]) throw new Error(`ffmpeg ssim failed: ${r.stderr.slice(-400)}`)
      min = Math.min(min, Number(m[1]))
    }
  return min
}
