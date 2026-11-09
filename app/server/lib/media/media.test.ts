// Upload classification (plan v2 §9, §14 rule 25) and the SVG allowlist sanitizer (§14 rule 26) with its corpus.
// WebM/Opus (plan 2026-11-02 §5.2): ffmpeg-made files when ffmpeg is installed, handcrafted EBML otherwise.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { which } from '../../../../scripts/lib/run-tools.js'
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

  it('knows PDFs by their header, with a 20 MB cap, whatever the file is called', () => {
    expect(classify(bytes('%PDF-1.7\n%âãÏÓ\n'))).toMatchObject({
      kind: 'pdf',
      ext: 'pdf',
      mime: 'application/pdf',
    })
    const big = new Uint8Array(20 * 1024 * 1024 + 1)
    big.set(bytes('%PDF-1.4'))
    expect(() => classify(big)).toThrow(/20 MB/)
  })

  it('checks MP4 clips: H.264, AAC or none, length, dimensions', () => {
    expect(classify(fx('a169.mp4'))).toMatchObject({ kind: 'video', ext: 'mp4', width: 1920, height: 1080 })
    expect(classify(fx('a169.mp4')).durationSec).toBeCloseTo(2, 1)
    expect(() => classify(fx('hevc.mp4'))).toThrow(/H\.264/)
    expect(() => classify(fx('truncated.mp4'))).toThrow(/couldn't be read/)
    expect(classify(fx('hevc.mp4'), { head: true }).kind).toBe('video')
  })

  it.each([
    ['tone.mp3', 'mp3', 'audio/mpeg', 1.5],
    ['tone-cbr-raw.mp3', 'mp3', 'audio/mpeg', 1.57],
    ['tone-vbr.mp3', 'mp3', 'audio/mpeg', 1.5],
    ['tone.m4a', 'm4a', 'audio/mp4', 1.5],
    ['tone.wav', 'wav', 'audio/wav', 1.5],
    ['tone.ogg', 'ogg', 'audio/ogg', 1.5],
    ['tone.opus', 'ogg', 'audio/ogg', 1.5],
  ])('knows %s as audio by its bytes, with its length', (file, ext, mime, seconds) => {
    const c = classify(fx(`audio/${file}`))
    expect(c).toMatchObject({ kind: 'audio', ext, mime, width: null, height: null })
    expect(c.durationSec).toBeCloseTo(seconds, 1)
  })

  it('keeps a clip with sound a video, and refuses audio over the caps', () => {
    expect(classify(fx('audio/clip-with-audio.mp4'))).toMatchObject({ kind: 'video', width: 64, height: 36 })
    const big = new Uint8Array(50 * 1024 * 1024 + 1)
    big.set(fx('audio/tone.wav'))
    expect(() => classify(big)).toThrow(/50 MB/)
    // A WAV header claiming 11 minutes of 8 kHz mono PCM.
    const wav = fx('audio/tone.wav').slice()
    const view = new DataView(wav.buffer)
    const rate = view.getUint32(28, true)
    let o = 12
    while (String.fromCharCode(...wav.subarray(o, o + 4)) !== 'data') o += 8 + view.getUint32(o + 4, true)
    view.setUint32(28, Math.floor((wav.byteLength - o - 8) / 660), true)
    expect(rate).toBe(16000)
    expect(() => classify(wav)).toThrow(/10 minutes/)
  })

  it('refuses audio it cannot use: Ogg video, compressed WAV, stray sync bytes', () => {
    const theora = bytes('OggS', [0, 2], new Array(20).fill(0), [1, 30], '\x80theora', new Array(22).fill(0))
    expect(() => classify(theora)).toThrow(/Ogg video/)
    const adpcm = fx('audio/tone.wav').slice()
    adpcm[20] = 2
    expect(() => classify(adpcm)).toThrow(/uncompressed PCM/)
    expect(() => classify(bytes([0xff, 0xfb, 0x90, 0x00], new Array(600).fill(7)))).toThrow(/Upload PNG/)
  })

  it('refuses anything else, whatever its name says', () => {
    expect(() => classify(bytes('<html><script>alert(1)</script>'))).toThrow(MediaError)
    expect(() => classify(bytes('GIF89a....'))).toThrow(/Upload PNG/)
  })
})

// ───────── WebM ─────────

/** An EBML element: id bytes, an 8-byte size (or unknown) and the body. */
const el = (id: number[], ...body: (number[] | string)[]) => {
  const b = [...bytes(...body)]
  return [...id, 0x01, 0, 0, 0, ...be32(b.length), ...b]
}
const unknownSize = (id: number[], ...body: (number[] | string)[]) => [
  ...id,
  0x01,
  ...new Array(7).fill(0xff),
  ...bytes(...body),
]
const EBML = (docType = 'webm') => el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], docType))
const TRACK = (type: number, codec: string, channels = 1) =>
  el([0xae], el([0x83], [type]), el([0x86], codec), type === 2 ? el([0xe1], el([0x9f], [channels])) : [])
const TRACKS = (...entries: number[][]) => el([0x16, 0x54, 0xae, 0x6b], ...entries)
const INFO = (durationMs?: number) => {
  const d = new Uint8Array(8)
  if (durationMs !== undefined) new DataView(d.buffer).setFloat64(0, durationMs)
  return el(
    [0x15, 0x49, 0xa9, 0x66],
    el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]),
    durationMs !== undefined ? el([0x44, 0x89], [...d]) : [],
  )
}
/** A Cluster at `ms` holding one SimpleBlock `rel` ms later, both of unknown size like MediaRecorder writes. */
const CLUSTER = (ms: number, rel: number) =>
  unknownSize(
    [0x1f, 0x43, 0xb6, 0x75],
    el([0xe7], be32(ms)),
    el([0xa3], [0x81, (rel >> 8) & 255, rel & 255, 0x80], new Array(20).fill(9)),
  )
const webm = (...segment: number[][]) =>
  new Uint8Array([...EBML(), ...unknownSize([0x18, 0x53, 0x80, 0x67], ...segment)])

const ffmpeg = which('ffmpeg')

describe('classify WebM', () => {
  it('reads a MediaRecorder-style WebM/Opus (unknown sizes, no Duration) from its last Cluster', () => {
    const c = classify(webm(INFO(), TRACKS(TRACK(2, 'A_OPUS')), CLUSTER(0, 0), CLUSTER(1000, 480)))
    expect(c).toMatchObject({ kind: 'audio', ext: 'webm', mime: 'audio/webm', width: null, height: null })
    expect(c.durationSec).toBeCloseTo(1.48, 3)
    expect(classify(webm(INFO(2500), TRACKS(TRACK(2, 'A_VORBIS', 2)))).durationSec).toBe(2.5)
    // Matroska audio (.mka) reads the same way.
    const mka = new Uint8Array([
      ...EBML('matroska'),
      ...el([0x18, 0x53, 0x80, 0x67], INFO(1000), TRACKS(TRACK(2, 'A_OPUS'))),
    ])
    expect(classify(mka).durationSec).toBe(1)
  })

  it('refuses video, other codecs, extra tracks and too many channels', () => {
    expect(() => classify(webm(INFO(1000), TRACKS(TRACK(1, 'V_VP9'), TRACK(2, 'A_OPUS'))))).toThrow(
      /WebM video/,
    )
    expect(() => classify(webm(INFO(1000), TRACKS(TRACK(2, 'A_AAC'))))).toThrow(/Opus or Vorbis/)
    expect(() => classify(webm(INFO(1000), TRACKS(TRACK(2, 'A_OPUS'), TRACK(2, 'A_OPUS'))))).toThrow(
      /exactly one/,
    )
    expect(() => classify(webm(INFO(1000), TRACKS(TRACK(17, 'S_TEXT/UTF8'), TRACK(2, 'A_OPUS'))))).toThrow(
      /exactly one/,
    )
    expect(() => classify(webm(INFO(1000), TRACKS(TRACK(2, 'A_OPUS', 12))))).toThrow(/8 channels/)
    expect(() => classify(webm(INFO(1000)))).toThrow(/no track list/)
    expect(() => classify(new Uint8Array([...EBML('mkvx'), ...webm().subarray(EBML().length)]))).toThrow(
      /isn't WebM/,
    )
  })

  it('keeps the 50 MB and 10 minute caps', () => {
    expect(() => classify(webm(INFO(601_000), TRACKS(TRACK(2, 'A_OPUS'))))).toThrow(/10 minutes/)
    const big = new Uint8Array(50 * 1024 * 1024 + 1)
    big.set(webm(INFO(1000), TRACKS(TRACK(2, 'A_OPUS'))))
    expect(() => classify(big)).toThrow(/50 MB/)
  })

  it('is bounded on malformed bytes: truncated, huge sizes, unknown sizes, floods and nesting', () => {
    const ok = webm(INFO(1000), TRACKS(TRACK(2, 'A_OPUS')))
    for (const n of [4, 12, 40, ok.length - 3])
      expect(() => classify(ok.subarray(0, n)), `cut at ${n}`).toThrow(/couldn't be read/)
    // A Tracks element claiming 2^56 - 2 bytes.
    const huge = webm(
      INFO(1000),
      [0x16, 0x54, 0xae, 0x6b, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe],
      TRACK(2, 'A_OPUS'),
    )
    expect(() => classify(huge)).toThrow(/ends early/)
    // Unknown sizes only where Matroska allows them (Segment, Cluster).
    expect(() =>
      classify(webm(INFO(1000), unknownSize([0x16, 0x54, 0xae, 0x6b], TRACK(2, 'A_OPUS')))),
    ).toThrow(/unknown size/)
    // An id with no length marker.
    expect(() => classify(webm([0x00, 0x81, 0x00]))).toThrow(/malformed element/)
    const flood = webm(...new Array(5000).fill(el([0xec], [0])), TRACKS(TRACK(2, 'A_OPUS')))
    // 10,000 nested Segments around the track list: skipped over, never recursed into.
    const inner = TRACKS(TRACK(2, 'A_OPUS'))
    const nested = new Uint8Array(12 * 10_000 + inner.length)
    for (let i = 0; i < 10_000; i++)
      nested.set([0x18, 0x53, 0x80, 0x67, 0x01, 0, 0, 0, ...be32(nested.length - 12 * (i + 1))], 12 * i)
    nested.set(inner, 12 * 10_000)
    // A long run of stray Cluster ids at the end (no Duration) costs one scan of the tail.
    const stray = new Uint8Array([
      ...webm(INFO(), TRACKS(TRACK(2, 'A_OPUS'))),
      ...new Array(200_000).fill(0).flatMap(() => [0x1f, 0x43, 0xb6, 0x75]),
    ])
    const deep = webm(INFO(1000), [...nested])
    const t = performance.now()
    expect(() => classify(flood)).toThrow(/too many elements/)
    expect(() => classify(deep)).toThrow(/no track list/)
    expect(classify(stray).durationSec).toBeNull()
    expect(performance.now() - t).toBeLessThan(2000)
  })

  describe.skipIf(!ffmpeg)('with ffmpeg', () => {
    const make = (args: string[]) => {
      const d = mkdtempSync(join(tmpdir(), 'va-webm-'))
      try {
        const out = join(d, 'out.webm')
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out])
        return new Uint8Array(readFileSync(out))
      } finally {
        rmSync(d, { recursive: true, force: true })
      }
    }
    const sine = ['-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1.5']

    it.each([
      ['Opus', [...sine, '-c:a', 'libopus', '-b:a', '32k']],
      ['Opus, streamed (no Duration, unknown sizes)', [...sine, '-c:a', 'libopus', '-live', '1']],
      ['Vorbis', [...sine, '-ac', '2', '-c:a', 'vorbis', '-strict', '-2']],
    ])('knows %s WebM as audio, with its length', (_name, args) => {
      const c = classify(make(args))
      expect(c).toMatchObject({ kind: 'audio', ext: 'webm', mime: 'audio/webm' })
      expect(c.durationSec).toBeCloseTo(1.5, 1)
    })

    it('refuses a WebM with a video track, and a truncated one', () => {
      const av = make([
        '-f',
        'lavfi',
        '-i',
        'testsrc=s=64x36:d=1',
        ...sine,
        '-c:v',
        'libvpx-vp9',
        '-c:a',
        'libopus',
        '-shortest',
      ])
      expect(() => classify(av)).toThrow(/WebM video/)
      const opus = make([...sine, '-c:a', 'libopus'])
      expect(() => classify(opus.subarray(0, 60))).toThrow(/couldn't be read/)
    })
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
