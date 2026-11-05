// The frame and SSIM helpers the redo-a-scene live test uses (scripts/e2e/lib/ssim.ts).
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sampleFrame, ssim, tileSsim } from './ssim.js'

const fixture = (f: string) => join(process.cwd(), 'test/fixtures', f)
/** One generated picture (an ffmpeg lavfi source). */
const picture = (src: string, out: string) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', out])

describe('ssim', () => {
  it('scores a frame against itself as 1, and different pictures lower', () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-ssim-'))
    const a = join(dir, 'a.png')
    const again = join(dir, 'again.png')
    sampleFrame(fixture('a169.mp4'), 0.5, a)
    sampleFrame(fixture('a169.mp4'), 0.5, again)
    expect(ssim(a, again)).toBeCloseTo(1, 6)
    const bars = join(dir, 'bars.png')
    const noise = join(dir, 'noise.png')
    picture('testsrc=size=320x180', bars)
    // Another size: scaled to the first before comparing.
    picture('mandelbrot=size=160x90', noise)
    expect(ssim(bars, bars)).toBeCloseTo(1, 6)
    expect(ssim(bars, noise)).toBeLessThan(0.5)
  })

  it('finds a small change in its tile that barely moves the whole frame', () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-ssim-'))
    const bars = join(dir, 'bars.png')
    const marked = join(dir, 'marked.png')
    picture('testsrc=size=640x360:duration=1', bars)
    picture('testsrc=size=640x360:duration=1,drawbox=x=20:y=20:w=60:h=16:color=white:t=fill', marked)
    expect(ssim(bars, marked)).toBeGreaterThan(0.97)
    expect(tileSsim(bars, marked)).toBeLessThan(ssim(bars, marked) - 0.05)
    expect(tileSsim(bars, bars)).toBeCloseTo(1, 6)
  })

  it('fails loudly on a missing file', () => {
    expect(() => ssim('/nonexistent/a.png', '/nonexistent/b.png')).toThrow(/ffmpeg ssim failed/)
  })
})
