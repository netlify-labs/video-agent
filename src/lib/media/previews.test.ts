import { describe, expect, it } from 'vitest'
import { PREVIEW_NAMES, isLqip, isPreviewFile, sniffPreview } from './previews.js'

const enc = (s: string) => new TextEncoder().encode(s)

describe('preview variants', () => {
  it('knows its file names', () => {
    expect(PREVIEW_NAMES).toEqual([
      'poster-480.avif',
      'poster-960.avif',
      'poster-480.webp',
      'poster-960.webp',
      'clip.webm',
      'clip.mp4',
    ])
    expect(isPreviewFile('clip.mp4')).toBe(true)
    expect(isPreviewFile('video.mp4')).toBe(false)
    expect(isPreviewFile('toString')).toBe(false)
  })

  it('accepts only small base64 WebP or JPEG data URIs as placeholders', () => {
    expect(isLqip('data:image/webp;base64,UklGRjgAAABXRUJQ')).toBe(true)
    expect(isLqip('data:image/jpeg;base64,/9j/4AAQ==')).toBe(true)
    expect(isLqip('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isLqip('data:image/webp;base64,AAAA");background:url(https://x)')).toBe(false)
    expect(isLqip(`data:image/webp;base64,${'A'.repeat(4000)}`)).toBe(false)
    expect(isLqip(undefined)).toBe(false)
  })

  it('checks magic bytes against the name', () => {
    expect(sniffPreview('poster-480.webp', enc('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe(true)
    expect(sniffPreview('poster-480.webp', enc('\x00\x00\x00\x1cftypavif'))).toBe(false)
    expect(sniffPreview('poster-960.avif', enc('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00mif1'))).toBe(true)
    expect(sniffPreview('poster-960.avif', enc('\x00\x00\x00\x18ftypisom'))).toBe(false)
    expect(sniffPreview('clip.webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0]))).toBe(true)
    expect(sniffPreview('clip.mp4', enc('\x00\x00\x00\x18ftypisom'))).toBe(true)
    expect(sniffPreview('clip.mp4', enc('GIF89a'))).toBe(false)
  })
})
