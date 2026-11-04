// A remix's source archive (plan 2026-11-03 §2 gotcha 3, §3.1 step 4): a narrated version's composition loses its
// recorded narration (layer, AI-voice levels, held frame, cues, files) deterministically and still conforms; any
// other source is copied byte for byte; archives that are too large or damaged are refused with a typed error.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyEdits,
  applyNarration,
  duckPoints,
  HOLD_STILL_SRC,
  holdBeatOf,
  load,
  NARRATION_SRC,
  read,
  validate,
  type Caption,
  type Summary,
} from '../src/lib/contract.js'
import { cleanRemixSource, RemixSourceError } from '../src/lib/remix-source.js'
import { readTarGz, writeTarGz } from '../src/lib/tar.js'
import {
  IDENTITY_FIT,
  SAMPLE_RATE as S,
  type NarrationClip,
  type NarrationOp,
  type NarrationTracks,
  type Span,
} from '../src/lib/timeline.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
const rawSummary = JSON.parse(fx('summary.json')) as Summary
/** The voice fixture as the patcher lays it out: 9 s, AI voice in intro and outro, music ducked under it. */
const base = applyEdits(fx('index.html'), rawSummary, [])
const baseHtml = base.html
const baseSummary = base.summary

const clip = (o: Partial<NarrationClip> & Pick<NarrationClip, 'id'>): NarrationClip => ({
  mediaId: 'take1',
  srcStart: 0,
  srcEnd: 2 * S,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start: 0,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...o,
})
const op = (t: Partial<NarrationTracks> = {}): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips: [clip({ id: 'a', start: 4 * S })],
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'under', volumeDb: -6 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
    ...t,
  },
  cleanup: 'light',
})
const takes = new Map<string, Span[]>([['take1', [[0, 2 * S]]]])
const cues: Caption[] = [
  {
    start: 4,
    end: 5.5,
    text: 'In my own words.',
    narration: true,
    id: 'n1',
    words: [{ text: 'In', start: 4, end: 4.2 }],
  },
  { start: 9.2, end: 9.8, text: 'Past the end.', narration: true, id: 'n2' },
]
const narratedSummary: Summary = {
  ...baseSummary,
  captions: [...(baseSummary.captions ?? []), ...cues].sort((a, b) => a.start - b.start),
}

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** A run's archive of a composition, with the voice clips, vendor script and anything in `extra`. */
function archive(html: string, summary: Summary, extra: Record<string, Uint8Array> = {}) {
  return writeTarGz(
    new Map<string, Uint8Array>([
      ['index.html', enc(html)],
      ['summary.json', enc(JSON.stringify(summary, null, 2))],
      ['assets/voice/script.json', enc(fx('assets/voice/script.json'))],
      ['assets/voice/voice.json', enc(fx('assets/voice/voice.json'))],
      ['assets/voice/intro.wav', new Uint8Array([1, 2, 3])],
      ['assets/voice/outro.wav', new Uint8Array([4, 5, 6])],
      ['vendor/va-contract.js', enc('/* contract runtime */')],
      ...Object.entries(extra),
    ]),
  )
}

/** A narrated version: narration over the AI voice (ducked or muted), running 1 s past the end on a held frame. */
function narrated(t: Partial<NarrationTracks> = {}) {
  const html = applyNarration(baseHtml, narratedSummary, op(t), takes, { holdSeconds: 1 }).html
  return {
    html,
    tarGz: archive(html, narratedSummary, {
      [NARRATION_SRC]: new Uint8Array(64),
      'assets/narration/notes.json': enc('{}'),
      [HOLD_STILL_SRC]: new Uint8Array([137, 80, 78, 71]),
    }),
  }
}

const musicLane = (h: string) => /id="music"[^>]*data-automation="([^"]*)"/.exec(h)?.[1]
const voices = (h: string) =>
  read(load(h))
    .audio.filter((a) => a.role === 'voice')
    .map((a) => ({ id: a.id, volume: a.volume, muted: a.muted }))
const volumeAttr = (h: string, id: string) =>
  new RegExp(`<audio id="${id}"[^>]*data-volume="([^"]*)"`).exec(h)?.[1]

function expectRefused(f: () => unknown, problem: RemixSourceError['problem']) {
  try {
    f()
  } catch (e) {
    expect(e).toBeInstanceOf(RemixSourceError)
    expect((e as RemixSourceError).problem).toBe(problem)
    return e as RemixSourceError
  }
  throw new Error('expected a RemixSourceError')
}

describe('cleanRemixSource: narrated sources', () => {
  it('the fixture really is narrated: bus layer, ducked AI voice, music dipping under speech, hold, cues', () => {
    const { html } = narrated()
    expect(html).toContain('id="va-narration"')
    expect(volumeAttr(html, 'voice-intro')).toBe('0.5')
    expect(musicLane(html)).not.toBe(musicLane(baseHtml))
    expect(holdBeatOf(load(html))).not.toBeNull()
    expect(validate(html, narratedSummary)).toEqual([])
  })

  for (const [name, tracks] of [
    ['ducked under', { aiVoice: { mode: 'under', volumeDb: -6 } }],
    ['replaced by', { aiVoice: { mode: 'replace', volumeDb: 0 } }],
    ['muting everything for', { original: { muteAll: true } }],
  ] as [string, Partial<NarrationTracks>][]) {
    it(`removes narration the AI voice was ${name}, back to the composition before narration`, () => {
      const { html, tarGz } = narrated(tracks)
      expect(voices(html)).not.toEqual(voices(baseHtml))
      const out = cleanRemixSource(tarGz, { narrated: true })
      expect(out.narrationDropped).toBe(true)
      expect(out.sha256).toBe(sha(out.bytes))
      const files = readTarGz(out.bytes)
      const cleaned = dec(files.get('index.html'))
      const summary = JSON.parse(dec(files.get('summary.json'))) as Summary

      expect(cleaned).not.toContain('va-narration')
      expect(cleaned).not.toContain('data-va-layer="narration"')
      expect(cleaned).not.toContain('data-va-audio="narration"')
      expect(cleaned).not.toContain('data-va-narration-mix')
      expect(cleaned).not.toContain('data-va-hold')
      // The AI voice and music sound as they did before the narration was recorded.
      expect(voices(cleaned)).toEqual(voices(baseHtml))
      expect(volumeAttr(cleaned, 'voice-intro')).toBe(volumeAttr(baseHtml, 'voice-intro'))
      expect(volumeAttr(cleaned, 'music')).toBe(volumeAttr(baseHtml, 'music'))
      // No dip left for the narration's speech: the lane is the AI voice's alone.
      expect(musicLane(cleaned)).toBe(musicLane(baseHtml))
      expect(duckPoints(load(cleaned), 0.3)).toEqual(duckPoints(load(baseHtml), 0.3))
      expect(read(load(cleaned)).duration).toBe(9)
      // In fact the whole composition is the one before narration.
      expect(cleaned).toBe(baseHtml)

      expect(summary.captions?.some((c) => c.narration)).toBe(false)
      expect(summary.captions).toEqual(baseSummary.captions)
      expect(summary.title).toBe(baseSummary.title)
      expect(validate(cleaned, summary)).toEqual([])

      expect([...files.keys()].filter((p) => p.startsWith('assets/narration/'))).toEqual([])
      expect([...files.keys()].filter((p) => p.startsWith('assets/hold/'))).toEqual([])
      expect([...files.keys()].sort()).toEqual([
        'assets/voice/intro.wav',
        'assets/voice/outro.wav',
        'assets/voice/script.json',
        'assets/voice/voice.json',
        'index.html',
        'summary.json',
        'vendor/va-contract.js',
      ])
      expect([...(files.get('assets/voice/intro.wav') ?? [])]).toEqual([1, 2, 3])
    })
  }

  it('keeps a track the person muted themselves muted', () => {
    const mutedBase = applyEdits(baseHtml, baseSummary, [{ op: 'audio', id: 'voice-outro', muted: true }])
    const html = applyNarration(mutedBase.html, narratedSummary, op(), takes).html
    const out = cleanRemixSource(archive(html, narratedSummary), { narrated: true })
    const cleaned = dec(readTarGz(out.bytes).get('index.html'))
    expect(voices(cleaned)).toEqual(voices(mutedBase.html))
    expect(voices(cleaned).find((v) => v.id === 'voice-outro')?.muted).toBe(true)
    expect(cleaned).toBe(applyNarration(mutedBase.html, mutedBase.summary, null).html)
  })

  it('is deterministic: the same source cleans to the same bytes', () => {
    const { tarGz } = narrated()
    const a = cleanRemixSource(tarGz, { narrated: true })
    const b = cleanRemixSource(tarGz.slice(), { narrated: true })
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
    expect(a.sha256).toBe(b.sha256)
    // Cleaning a cleaned source changes nothing more.
    const again = cleanRemixSource(a.bytes, { narrated: true })
    expect(again.sha256).toBe(a.sha256)
  })

  it('cleans a source flagged narrated that has no narration in it to a valid copy', () => {
    const out = cleanRemixSource(archive(baseHtml, baseSummary), { narrated: true })
    const files = readTarGz(out.bytes)
    expect(dec(files.get('index.html'))).toBe(baseHtml)
    expect(
      validate(dec(files.get('index.html')), JSON.parse(dec(files.get('summary.json'))) as Summary),
    ).toEqual([])
  })

  it("refuses a narrated composition that doesn't conform, or has no index.html or a broken summary.json", () => {
    const broken = narrated().html.replace('data-va-contract="1"', 'data-va-contract="0"')
    const e = expectRefused(
      () => cleanRemixSource(archive(broken, narratedSummary), { narrated: true }),
      'invalid',
    )
    expect(e.violations).toContain('The root needs data-va-contract="1".')
    expectRefused(
      () => cleanRemixSource(writeTarGz(new Map([['summary.json', enc('{}')]])), { narrated: true }),
      'invalid',
    )
    const badJson = writeTarGz(
      new Map([
        ['index.html', enc(narrated().html)],
        ['summary.json', enc('{nope')],
      ]),
    )
    expectRefused(() => cleanRemixSource(badJson, { narrated: true }), 'invalid')
  })
})

describe('cleanRemixSource: other sources', () => {
  it('passes a source that is not narrated through byte for byte', () => {
    const tarGz = archive(baseHtml, baseSummary)
    const out = cleanRemixSource(tarGz, { narrated: false })
    expect(out.narrationDropped).toBe(false)
    expect(Buffer.from(out.bytes).equals(Buffer.from(tarGz))).toBe(true)
    expect(out.sha256).toBe(sha(tarGz))
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('cleanRemixSource: archives too large or damaged', () => {
  const big = writeTarGz(
    new Map([
      ['index.html', enc(baseHtml)],
      ['assets/media/huge.mp4', new Uint8Array(10 * 1024 * 1024 + 1)],
    ]),
  )
  const tooMany = writeTarGz(
    new Map(Array.from({ length: 2001 }, (_, i) => [`f${i}.txt`, enc('x')] as const)),
  )
  const valid = archive(baseHtml, baseSummary)
  const truncated = valid.subarray(0, Math.floor(valid.length / 2))
  const garbage = enc('this is not a tar.gz')

  for (const narratedFlag of [true, false])
    it(`refuses them${narratedFlag ? ' (narrated)' : ''} with a typed archive error`, () => {
      for (const tarGz of [big, tooMany, truncated, garbage]) {
        const e = expectRefused(() => cleanRemixSource(tarGz, { narrated: narratedFlag }), 'archive')
        expect(e.message).toMatch(/^The source archive can't be used: /)
      }
      expect(
        expectRefused(() => cleanRemixSource(big, { narrated: narratedFlag }), 'archive').message,
      ).toContain('huge.mp4 is over')
    })
})
