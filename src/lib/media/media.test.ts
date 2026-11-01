// Upload classification (plan v2 §9, §14 rule 25) and the SVG allowlist sanitizer (§14 rule 26) with its corpus.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classify, MediaError } from './classify.js'
import { sanitizeSvg, SvgError } from './svg.js'

const fx = (f: string) =>
  new Uint8Array(readFileSync(new URL(`../../../test/fixtures/${f}`, import.meta.url)))
const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)))
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

describe('classify', () => {
  it('reads PNG, JPEG and WebP dimensions from their headers', () => {
    const png = bytes([0x89], 'PNG\r\n\x1a\n', be32(13), 'IHDR', be32(640), be32(360), [8, 6, 0, 0, 0])
    expect(classify(png)).toMatchObject({ kind: 'image', ext: 'png', width: 640, height: 360 })
    expect(classify(fx('poster.jpg'))).toMatchObject({ kind: 'image', ext: 'jpg', mime: 'image/jpeg' })
    const webp = bytes(
      'RIFF',
      [0, 0, 0, 0],
      'WEBPVP8X',
      [10, 0, 0, 0, 0, 0, 0, 0],
      [0x7f, 0x07, 0],
      [0x37, 0x04, 0],
    )
    expect(classify(webp)).toMatchObject({ kind: 'image', ext: 'webp', width: 1920, height: 1080 })
  })

  it('refuses images over 40 megapixels or 5 MB', () => {
    const huge = bytes([0x89], 'PNG\r\n\x1a\n', be32(13), 'IHDR', be32(10000), be32(5000), [8, 6, 0, 0, 0])
    expect(() => classify(huge)).toThrow(/40 megapixels/)
    const big = new Uint8Array(5 * 1024 * 1024 + 1)
    big.set(bytes([0x89], 'PNG\r\n\x1a\n', be32(13), 'IHDR', be32(10), be32(10)))
    expect(() => classify(big)).toThrow(/5 MB/)
  })

  it('knows fonts by their magic, with a 2 MB cap', () => {
    expect(classify(bytes('wOF2', [0, 1]))).toMatchObject({ kind: 'font', ext: 'woff2' })
    expect(classify(bytes('OTTO', [0, 1]))).toMatchObject({ kind: 'font', ext: 'otf' })
    expect(classify(bytes([0, 1, 0, 0, 0, 9]))).toMatchObject({ kind: 'font', ext: 'ttf' })
    const big = new Uint8Array(2 * 1024 * 1024 + 1)
    big.set(bytes('wOF2'))
    expect(() => classify(big)).toThrow(/2 MB/)
  })

  it('checks MP4 clips: H.264, AAC or none, length, dimensions', () => {
    expect(classify(fx('a169.mp4'))).toMatchObject({ kind: 'video', ext: 'mp4', width: 1920, height: 1080 })
    expect(classify(fx('a169.mp4')).durationSec).toBeCloseTo(2, 1)
    expect(() => classify(fx('hevc.mp4'))).toThrow(/H\.264/)
    expect(() => classify(fx('truncated.mp4'))).toThrow(/couldn't be read/)
    expect(classify(fx('hevc.mp4'), { head: true }).kind).toBe('video')
  })

  it('refuses anything else, whatever its name says', () => {
    expect(() => classify(bytes('<html><script>alert(1)</script>'))).toThrow(MediaError)
    expect(() => classify(bytes('GIF89a....'))).toThrow(/Upload PNG/)
  })
})

const svg = (inner: string, attrs = '') =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`,
  )
const clean = (input: Uint8Array) => new TextDecoder().decode(sanitizeSvg(input))

describe('SVG sanitizer', () => {
  it('keeps the drawing: shapes, gradients, internal references, text', () => {
    const out = clean(
      svg(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#14b8a6"/></linearGradient></defs>' +
          '<rect width="10" height="10" fill="url(#g)"/><use href="#g"/><text x="1" y="5">Hi</text>',
      ),
    )
    expect(out).toContain('<linearGradient id="g">')
    expect(out).toContain('fill="url(#g)"')
    expect(out).toContain('<use href="#g">')
    expect(out).toContain('>Hi</text>')
  })

  // The malicious corpus (spike S5).
  it.each([
    ['script element', '<script>alert(1)</script>', /script|alert/i],
    ['event handler', '<rect onload="alert(1)" onclick="x()"/>', /onload|onclick|alert/i],
    ['root event handler', '', /onload/i, ' onload="alert(1)"'],
    [
      'foreignObject',
      '<foreignObject><iframe src="https://evil.example"/></foreignObject>',
      /foreignobject|iframe|evil/i,
    ],
    ['external use', '<use href="https://evil.example/s.svg#x"/>', /evil/i],
    ['javascript link', '<a href="javascript:alert(1)"><rect/></a>', /javascript|<a/i],
    ['xlink javascript', '<use xlink:href="javascript:alert(1)"/>', /javascript/i],
    ['data: image', '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>', /data:/i],
    ['remote image', '<image href="https://evil.example/t.png"/>', /evil/i],
    ['CSS url in style', '<rect style="fill: url(https://evil.example/x)"/>', /evil/i],
    ['CSS import in style', '<rect style="@import url(//evil.example/a.css)"/>', /evil|@import/i],
    [
      'style element',
      '<style>@import url("https://evil.example/a.css"); rect{fill:url(//evil.example)}</style>',
      /evil|<style/i,
    ],
    [
      'animate href',
      '<a><animate attributeName="href" to="javascript:alert(1)"/></a>',
      /animate|javascript/i,
    ],
    ['set mutation', '<set attributeName="xlink:href" to="https://evil.example"/>', /evil|<set/i],
    ['embed and object', '<embed src="x.swf"/><object data="x"/>', /embed|object/i],
    ['remote filter url', '<rect filter="url(https://evil.example/f.svg#f)"/>', /evil/i],
  ])('strips %s', (_name, inner, banned, attrs = '') => {
    expect(clean(svg(inner, attrs))).not.toMatch(banned)
  })

  it('never expands XML entities and drops the doctype', () => {
    const xxe = new TextEncoder().encode(
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY lol "lol">]>' +
        '<svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;&lol;</text></svg>',
    )
    const out = clean(xxe)
    expect(out).not.toMatch(/DOCTYPE|ENTITY|passwd/)
    expect(out).not.toContain('lollol')
  })

  it('is bounded: size, element count and depth', () => {
    expect(() => sanitizeSvg(new Uint8Array(1024 * 1024 + 1))).toThrow(/1 MB/)
    expect(() => clean(svg('<g>'.repeat(80) + '</g>'.repeat(80)))).toThrow(SvgError)
    expect(() => clean(svg('<rect/>'.repeat(20_001)))).toThrow(/too many elements/)
    expect(() => sanitizeSvg(new TextEncoder().encode('<html></html>'))).toThrow(/isn't an SVG/)
  })
})
