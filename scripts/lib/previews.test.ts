// The optional preview variants render-job makes, from a real MP4 with the local ffmpeg (skipped without one). Set
// FFMPEG to try another build (the runner's ffmpeg-static has libwebp and libaom-av1; Homebrew's lacks libwebp).
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLqip, sniffPreview } from '../../app/server/lib/media/previews.js'
import { encoders, makePreviews } from './previews.js'
import { which } from './run-tools.js'

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
const fixture = (name: string) => new URL(`../../app/test/fixtures/${name}`, import.meta.url).pathname
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'previews-'))
  dirs.push(d)
  return d
}

describe.skipIf(!process.env.FFMPEG && !which('ffmpeg'))('makePreviews', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('makes every variant this ffmpeg can encode, and skips the rest with a reason', () => {
    const have = encoders(ffmpeg)
    const out = tmp()
    const r = makePreviews({ video: fixture('a169.mp4'), out, posterAt: 0.6, durationSec: 2, ffmpeg })
    const expected = [
      ...(have.has('libaom-av1') || have.has('libsvtav1') ? ['poster-480.avif', 'poster-960.avif'] : []),
      ...(have.has('libwebp') ? ['poster-480.webp', 'poster-960.webp'] : []),
      ...(have.has('libvpx-vp9') ? ['clip.webm'] : []),
      ...(have.has('libx264') ? ['clip.mp4'] : []),
    ]
    expect([...r.files].sort()).toEqual(expected.sort())
    expect(r.files.length + r.skipped.length).toBe(6)
    for (const name of r.files) {
      const bytes = readFileSync(join(out, name))
      expect(sniffPreview(name, bytes)).toBe(true)
      expect(bytes.byteLength).toBeLessThan(200_000)
    }
    if (have.has('libwebp'))
      expect(statSync(join(out, 'poster-480.webp')).size).toBeLessThan(
        statSync(join(out, 'poster-960.webp')).size,
      )
    // The placeholder is a WebP with libwebp, else a JPEG; either way a short data URI.
    expect(isLqip(r.lqip)).toBe(true)
    expect(r.lqip?.startsWith(have.has('libwebp') ? 'data:image/webp' : 'data:image/jpeg')).toBe(true)
    expect(r.lqip?.length).toBeLessThan(1000)
    // Intermediate files are cleaned up.
    expect(readdirSync(out).filter((f) => f.startsWith('.'))).toEqual([])
  })

  it('the clip is silent, at most 480 px wide and a faststart MP4', () => {
    const out = tmp()
    const r = makePreviews({ video: fixture('a169.mp4'), out, posterAt: 0.6, durationSec: 2, ffmpeg })
    if (!r.files.includes('clip.mp4')) return
    const mp4 = readFileSync(join(out, 'clip.mp4'))
    const text = mp4.toString('latin1')
    expect(text.indexOf('moov')).toBeLessThan(text.indexOf('mdat'))
    expect(text).not.toContain('soun')
    expect(text).toContain('vide')
  })

  it('never throws: a broken input or a missing ffmpeg only skips variants', () => {
    const broken = makePreviews({
      video: fixture('truncated.mp4'),
      out: tmp(),
      posterAt: 0.6,
      durationSec: 2,
      ffmpeg,
    })
    expect(broken.files.filter((f) => f.startsWith('poster'))).toEqual([])
    expect(broken.skipped.length).toBeGreaterThan(0)

    const none = makePreviews({
      video: fixture('a169.mp4'),
      out: tmp(),
      posterAt: 0.6,
      durationSec: 2,
      ffmpeg: '/nonexistent/ffmpeg',
    })
    expect(none).toMatchObject({ files: [], lqip: null })
    expect(none.skipped.map((s) => s.name)).toContain('clip.mp4')
  })
})
