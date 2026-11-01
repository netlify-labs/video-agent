// Optional preview variants for the Library and embeds: small WebP/AVIF posters, a tiny LQIP placeholder and a short
// muted hover clip (WebM + MP4). Shared by render-job.ts and backfill-previews.ts. Every variant is best effort: one
// that fails, or needs an encoder this ffmpeg lacks, is skipped and the version falls back to poster.jpg/preview.gif.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PREVIEW_BYTES, isLqip, sniffPreview, type PreviewFile } from '../../src/lib/media/previews.js'
import { run } from './run-tools.js'

export interface PreviewResult {
  files: PreviewFile[]
  lqip: string | null
  skipped: { name: string; reason: string }[]
}

/** Poster widths; each is capped at the source width. */
const WIDTHS = [480, 960] as const
/** The hover clip: the first seconds, small and silent. */
export const CLIP_SEC = 6
const CLIP_WIDTH = 480
const CLIP_FPS = 24
const STEP_TIMEOUT_MS = 2 * 60_000

/** Names of the encoders this ffmpeg has (libwebp, libaom-av1, libsvtav1, libvpx-vp9, libx264, ...). */
export function encoders(ffmpeg = 'ffmpeg'): Set<string> {
  try {
    const out = run(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 30_000 })
    return new Set([...out.matchAll(/^\s*[VAS][.A-Z]{5}\s+(\S+)/gm)].map((m) => m[1] ?? ''))
  } catch {
    return new Set()
  }
}

/**
 * Makes the variants in `out` from `video`. `posterAt` is the second poster.jpg was taken at, so the stills show the
 * same frame. Never throws.
 */
export function makePreviews(o: {
  video: string
  out: string
  posterAt: number
  durationSec: number
  ffmpeg?: string
}): PreviewResult {
  const ffmpeg = o.ffmpeg ?? 'ffmpeg'
  const have = encoders(ffmpeg)
  const result: PreviewResult = { files: [], lqip: null, skipped: [] }
  const ff = (args: string[]) =>
    run(ffmpeg, ['-y', '-loglevel', 'error', ...args], { timeoutMs: STEP_TIMEOUT_MS })
  const skip = (name: string, reason: string) => result.skipped.push({ name, reason: reason.slice(0, 300) })
  const keep = (names: PreviewFile[]) => {
    for (const name of names) {
      const path = join(o.out, name)
      const ok =
        existsSync(path) &&
        statSync(path).size > 0 &&
        statSync(path).size <= MAX_PREVIEW_BYTES &&
        sniffPreview(name, readFileSync(path))
      if (ok) result.files.push(name)
      else {
        rmSync(path, { force: true })
        skip(name, 'missing, empty, too large or not the right format')
      }
    }
  }
  const attempt = (names: PreviewFile[], why: string | null, fn: () => void) => {
    if (why) {
      for (const n of names) skip(n, why)
      return
    }
    try {
      fn()
      keep(names)
    } catch (e) {
      for (const n of names) rmSync(join(o.out, n), { force: true })
      for (const n of names) skip(n, e instanceof Error ? e.message : String(e))
    }
  }

  // One lossless still of the poster frame, so every image variant starts from the same pixels (not the JPEG).
  const frame = join(o.out, '.poster-frame.png')
  try {
    ff(['-ss', o.posterAt.toFixed(2), '-i', o.video, '-frames:v', '1', frame])
  } catch (e) {
    skip('poster frame', e instanceof Error ? e.message : String(e))
  }
  const noFrame = existsSync(frame) ? null : 'no poster frame'
  const scaled = (w: number) => `scale='min(${w},iw)':-2:flags=lanczos`
  const sizes = (ext: string, codec: string[]) =>
    WIDTHS.flatMap((w) => ['-map', '0:v', '-vf', scaled(w), ...codec, join(o.out, `poster-${w}.${ext}`)])

  attempt(
    ['poster-480.webp', 'poster-960.webp'],
    noFrame ?? (have.has('libwebp') ? null : 'ffmpeg has no libwebp encoder'),
    () =>
      ff(['-i', frame, ...sizes('webp', ['-c:v', 'libwebp', '-quality', '72', '-compression_level', '6'])]),
  )
  const av1 = have.has('libaom-av1')
    ? ['-c:v', 'libaom-av1', '-still-picture', '1', '-crf', '34', '-cpu-used', '6', '-row-mt', '1']
    : have.has('libsvtav1')
      ? ['-c:v', 'libsvtav1', '-crf', '38', '-preset', '8']
      : null
  attempt(
    ['poster-480.avif', 'poster-960.avif'],
    noFrame ?? (av1 ? null : 'ffmpeg has no AV1 encoder (libaom-av1 or libsvtav1)'),
    () => ff(['-i', frame, ...sizes('avif', [...(av1 ?? []), '-pix_fmt', 'yuv420p', '-frames:v', '1'])]),
  )

  // LQIP: ~20px wide, inlined in the DTO as a data URI and blurred by the browser's upscaling.
  if (!noFrame) {
    const webp = have.has('libwebp')
    const lqip = join(o.out, webp ? '.lqip.webp' : '.lqip.jpg')
    try {
      ff([
        '-i',
        frame,
        '-vf',
        'scale=20:-2:flags=area',
        ...(webp ? ['-c:v', 'libwebp', '-quality', '40'] : ['-q:v', '10']),
        lqip,
      ])
      const uri = `data:image/${webp ? 'webp' : 'jpeg'};base64,${readFileSync(lqip).toString('base64')}`
      const chars = uri.length
      if (isLqip(uri)) result.lqip = uri
      else skip('lqip', `placeholder is not a small data URI (${chars} chars)`)
    } catch (e) {
      skip('lqip', e instanceof Error ? e.message : String(e))
    }
    rmSync(lqip, { force: true })
  }
  rmSync(frame, { force: true })

  // The hover clip: no audio, faststart MP4 and VP9 WebM, looped by the page.
  const clip = [
    '-t',
    String(Math.min(CLIP_SEC, o.durationSec)),
    '-i',
    o.video,
    '-an',
    '-vf',
    `fps=${CLIP_FPS},${scaled(CLIP_WIDTH)}`,
    '-pix_fmt',
    'yuv420p',
  ]
  attempt(['clip.webm'], have.has('libvpx-vp9') ? null : 'ffmpeg has no libvpx-vp9 encoder', () =>
    ff([
      ...clip,
      ...['-c:v', 'libvpx-vp9', '-crf', '46', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2'],
      ...['-row-mt', '1', join(o.out, 'clip.webm')],
    ]),
  )
  attempt(['clip.mp4'], have.has('libx264') ? null : 'ffmpeg has no libx264 encoder', () =>
    ff([
      ...clip,
      ...['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '31'],
      ...['-movflags', '+faststart', join(o.out, 'clip.mp4')],
    ]),
  )
  return result
}
