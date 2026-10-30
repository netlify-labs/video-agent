import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspectMp4, Mp4Error, sniff } from './mp4.js'

const fx = (name: string) => new Uint8Array(readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url)))

describe('inspectMp4', () => {
  it.each([
    ['a169.mp4', 1920, 1080],
    ['a916.mp4', 1080, 1920],
    ['a11.mp4', 1080, 1080],
    ['a45.mp4', 1080, 1350],
  ])('reads %s dimensions, duration and codec', (name, w, h) => {
    const info = inspectMp4(fx(name))
    expect(info.width).toBe(w)
    expect(info.height).toBe(h)
    expect(info.videoCodec).toBe('avc1')
    expect(info.fastStart).toBe(true)
    expect(info.durationSec).toBeGreaterThan(1.9)
    expect(info.durationSec).toBeLessThan(2.1)
  })

  it('reports moov after mdat as not fast-start', () => {
    expect(inspectMp4(fx('moov-at-end.mp4')).fastStart).toBe(false)
  })

  it('reports the HEVC codec so callers can reject it', () => {
    expect(inspectMp4(fx('hevc.mp4')).videoCodec).toBe('hvc1')
  })

  it('rejects a truncated file', () => {
    expect(() => inspectMp4(fx('truncated.mp4'))).toThrow(Mp4Error)
  })

  it('rejects garbage', () => {
    expect(() => inspectMp4(new TextEncoder().encode('not a video at all, just text'))).toThrow(Mp4Error)
  })
})

describe('sniff', () => {
  it('identifies poster, gif, captions and mp4', () => {
    expect(sniff(fx('poster.jpg'))).toBe('jpeg')
    expect(sniff(fx('preview.gif'))).toBe('gif')
    expect(sniff(fx('captions.vtt'))).toBe('vtt')
    expect(sniff(fx('a169.mp4'))).toBe('mp4')
    expect(sniff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe('unknown')
  })
})
