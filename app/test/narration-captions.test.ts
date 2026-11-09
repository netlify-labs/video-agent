// Narration captions (plan 2026-11-02 §6.6, bead va-2qq.3.13): grouping (2 x 42 characters, pauses over 300 ms,
// punctuation, 1-6 s), stable ids, the audible-track matrix, validate() accepting the new cue kind, the run step
// writing summary.json (and its failure fallback), and the empty captions.vtt a narrated version without cues gets,
// which finalize accepts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validate, type Caption, type Summary } from '../server/lib/contract.js'
import { sniff } from '../server/lib/media/mp4.js'
import {
  audibleCaptions,
  CUE_LINE_CHARS,
  cueId,
  groupWords,
  joinWords,
  textWidth,
  wrapWords,
  type CueWord,
  type NarrationCue,
} from '../server/lib/narration-captions.js'
import type { NarrationTracks } from '../server/lib/timeline.js'
import { toVtt } from '../../scripts/lib/captions.js'
import { applyNarrationCaptions, captionsForRender } from '../../scripts/lib/narration-captions.js'
import { harness, PROMPT, runToken } from './helpers.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
const html = fx('index.html')
const baseSummary = JSON.parse(fx('summary.json')) as Summary

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'va-ncap-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Words (given as a list) spoken back to back from `at`. */
const speakList = (list: string[], at = 0, dur = 0.25, gap = 0.05): CueWord[] =>
  list.map((t, i) => ({ text: t, start: at + i * (dur + gap), end: at + i * (dur + gap) + dur }))

describe('non-Latin and combining text (Intl.Segmenter)', () => {
  it('measures graphemes, with CJK and kana counting 2', () => {
    // "Grüße" written with a combining diaeresis: 6 UTF-16 units, 5 graphemes.
    const decomposed = 'Gru\u0308ße'
    expect(decomposed.length).toBe(6)
    expect(textWidth(decomposed)).toBe(5)
    expect(textWidth('日本語')).toBe(6)
    expect(textWidth('ｶﾀｶﾅ')).toBe(4) // half-width katakana stays narrow
    expect(textWidth('👩‍💻')).toBe(1)
  })

  it('joins Japanese and Chinese words without spaces, and mixed ones with one', () => {
    expect(joinWords(['今日は', '良い', '天気', 'です。'])).toBe('今日は良い天気です。')
    expect(joinWords(['我们', '开始', '吧'])).toBe('我们开始吧')
    expect(joinWords(['Netlify', 'の', 'デモ'])).toBe('Netlify のデモ')
    expect(joinWords(['Guten', 'Tag'])).toBe('Guten Tag')
  })

  it('wraps a Japanese cue at 21 wide characters a line', () => {
    const words = Array.from({ length: 12 }, () => 'です')
    expect(wrapWords(words)).toEqual(['です'.repeat(10), 'です'.repeat(2)])
    expect(wrapWords(words).every((l) => textWidth(l) <= CUE_LINE_CHARS)).toBe(true)
  })

  it('groups a Japanese transcript into cues: 2 lines of 21, after 。, no spaces', () => {
    const ja = speakList(
      [
        '今日は',
        'Netlify',
        'の',
        '新しい',
        '機能を',
        '紹介します。',
        'まず',
        'ダッシュボードを',
        '開いて',
        'ください。',
      ],
      0,
      0.4,
      0.02,
    )
    const cues = groupWords(ja)
    expect(cues.map((c) => c.text)).toEqual([
      '今日は Netlify の新しい機能を紹介します。',
      'まずダッシュボードを開いてください。',
    ])
    for (const c of cues)
      for (const line of c.text.split('\n')) expect(textWidth(line)).toBeLessThanOrEqual(CUE_LINE_CHARS)
  })

  it('a run of Japanese past 2 x 21 starts a new cue', () => {
    const cues = groupWords(
      speakList(
        Array.from({ length: 30 }, () => '日本'),
        0,
        0.15,
        0.01,
      ),
    )
    expect(cues.length).toBeGreaterThan(1)
    for (const c of cues) {
      expect(c.text.split('\n').length).toBeLessThanOrEqual(2)
      expect(c.text).not.toContain(' ')
    }
  })

  it('German: long compounds and decomposed umlauts are measured in graphemes', () => {
    const de = speak(
      'Die Donaudampfschifffahrtsgesellschaft begru\u0308ßt Sie herzlich. Bitte o\u0308ffnen Sie das Dashboard.',
      0,
      0.3,
      0.02,
    )
    const cues = groupWords(de)
    expect(cues.map((c) => c.text.normalize('NFC'))).toEqual([
      'Die Donaudampfschifffahrtsgesellschaft\nbegrüßt Sie herzlich.',
      'Bitte öffnen Sie das Dashboard.',
    ])
    for (const c of cues)
      for (const line of c.text.split('\n')) expect(textWidth(line)).toBeLessThanOrEqual(CUE_LINE_CHARS)
  })
})

/** Words spoken back to back from `at`, each `dur` long with `gap` between them. */
const speak = (text: string, at = 0, dur = 0.25, gap = 0.05): CueWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: at + i * (dur + gap), end: at + i * (dur + gap) + dur }))

describe('groupWords', () => {
  it('splits at a pause over 300 ms, not at a shorter one', () => {
    // "two" ends at 0.55 and "four" at 1.4: gaps of exactly 300 ms aren't over it.
    const cues = groupWords([...speak('one two', 0), ...speak('three four', 0.85), ...speak('five', 1.7)])
    expect(cues.map((c) => c.text)).toEqual(['one two three four five'])
    const split = groupWords([...speak('one two', 0), ...speak('three', 0.95)])
    expect(split.map((c) => c.text)).toEqual(['one two', 'three'])
  })

  it('ends a cue after a sentence once it has been up a second, and keeps a short sentence with the next', () => {
    const long = groupWords(speak('This sentence runs long enough. And this is the next one'))
    expect(long.map((c) => c.text)).toEqual(['This sentence runs long enough.', 'And this is the next one'])
    const short = groupWords(speak('Hi. I am Dana'))
    expect(short.map((c) => c.text)).toEqual(['Hi. I am Dana'])
  })

  it('wraps at 42 characters on at most 2 lines, then starts a new cue', () => {
    const words = speak(
      'Every event across every project in your organization lands in one place with retries and signatures included',
      0,
      0.1,
      0.02,
    )
    const cues = groupWords(words)
    expect(cues.length).toBeGreaterThan(1)
    for (const c of cues) {
      const lines = c.text.split('\n')
      expect(lines.length).toBeLessThanOrEqual(2)
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(CUE_LINE_CHARS)
    }
    expect(cues.flatMap((c) => c.words.map((w) => w.text)).join(' ')).toBe(words.map((w) => w.text).join(' '))
  })

  it('keeps cues between 1 and 6 seconds, never running into the next one', () => {
    // 30 slow words without a pause or punctuation: split at 6 s.
    const slow = groupWords(speak(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '), 0, 0.2, 0.1))
    for (const c of slow) expect(c.end - c.start).toBeLessThanOrEqual(6)
    // A lone word stays up a second, unless the next cue starts sooner.
    const [a, b] = groupWords([
      { text: 'Yes.', start: 1, end: 1.2 },
      { text: 'No.', start: 1.6, end: 1.8 },
    ])
    expect([a?.start, a?.end]).toEqual([1, 1.6])
    expect([b?.start, b?.end]).toEqual([1.6, 2.6])
  })

  it('gives each cue a stable id from its start and text, and keeps its words', () => {
    const one = groupWords(speak('Stable ids please'))
    const two = groupWords(speak('Stable ids please'))
    expect(one[0]?.id).toBe(two[0]?.id)
    expect(one[0]?.id).toMatch(/^nc_[0-9a-f]{12}$/)
    expect(cueId(0, 'Stable ids please')).toBe(one[0]?.id)
    expect(cueId(0.001, 'Stable ids please')).not.toBe(one[0]?.id)
    expect(cueId(0, 'Stable ids, please')).not.toBe(one[0]?.id)
    expect(one[0]).toMatchObject({ narration: true, start: 0, words: speak('Stable ids please') })
  })
})

const tracks = (
  mode: NarrationTracks['aiVoice']['mode'],
  o: { muted?: boolean; muteAll?: boolean } = {},
): Pick<NarrationTracks, 'narration' | 'aiVoice' | 'original'> => ({
  narration: { volumeDb: 0, muted: o.muted ?? false, solo: false },
  aiVoice: { mode, volumeDb: -12 },
  original: { muteAll: o.muteAll ?? false },
})

describe('audibleCaptions', () => {
  const ai = baseSummary.captions ?? []
  const mine = groupWords([...speak('My own words', 2.6), ...speak('and more', 5.0)])
  const kinds = (cs: Caption[]) => cs.map((c) => (c.narration ? 'n' : c.voice ? 'ai' : 'text'))

  it.each([
    ['replace', {}, ['n', 'n']],
    ['under', {}, ['ai', 'ai', 'n', 'text', 'n', 'ai']],
    ['keep', {}, ['ai', 'ai', 'n', 'text', 'n', 'ai']],
    ['replace', { muted: true }, []],
    ['under', { muted: true }, ['ai', 'ai', 'text', 'ai']],
    ['keep', { muteAll: true }, ['n', 'n']],
  ] as const)('%s %o', (mode, o, want) => {
    const out = audibleCaptions(ai, mine, tracks(mode, o))
    expect(kinds(out)).toEqual(want)
    expect(out.map((c) => c.start)).toEqual([...out.map((c) => c.start)].sort((a, b) => a - b))
  })

  it('replaces narration cues already in the list', () => {
    const out = audibleCaptions([...ai, ...mine], mine.slice(0, 1), tracks('keep'))
    expect(out.filter((c) => c.narration)).toEqual(mine.slice(0, 1))
  })
})

describe('validate() and narration cues', () => {
  const cue: NarrationCue = groupWords(speak('My own words', 2.6))[0]!

  it('accepts narration cues without a beat, next to the AI and text ones', () => {
    expect(validate(html, { ...baseSummary, captions: [...(baseSummary.captions ?? []), cue] })).toEqual([])
    expect(validate(html, { ...baseSummary, captions: [cue] })).toEqual([])
  })

  it('still needs an id, text and a positive length', () => {
    const v = validate(html, {
      ...baseSummary,
      captions: [
        { ...cue, id: '' },
        { ...cue, end: cue.start },
      ],
    })
    expect(v).toEqual([expect.stringMatching(/Narration caption "My own words" needs an id/)])
  })
})

describe('applyNarrationCaptions and captionsForRender', () => {
  const words = [...speak('Hello from my own voice.', 0.5), ...speak('Second line here', 3)]
  const op = (mode: NarrationTracks['aiVoice']['mode'], o: { muted?: boolean } = {}) => ({
    tracks: { ...tracks(mode, o), music: { duck: true, duckDb: -12 } },
  })

  function workspace() {
    const root = tmp()
    mkdirSync(join(root, 'video'), { recursive: true })
    const summaryPath = join(root, 'video', 'summary.json')
    writeFileSync(summaryPath, JSON.stringify(baseSummary))
    return { root, summaryPath }
  }
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Summary

  it('adds the narration cues to summary.json and keeps every frozen cue, idempotently', () => {
    const { summaryPath } = workspace()
    const s = applyNarrationCaptions(summaryPath, { status: 'ok', words })
    expect(s.title).toBe('Org webhooks')
    expect(s.captions?.filter((c) => c.narration)).toHaveLength(2)
    expect(s.captions?.filter((c) => !c.narration)).toEqual(baseSummary.captions)
    applyNarrationCaptions(summaryPath, { status: 'ok', words })
    expect(read(summaryPath)).toEqual(s)
    expect(validate(html, read(summaryPath))).toEqual([])
  })

  it('captions.vtt captions only what is audible: replace -> narration cues, under -> both, muted -> AI only', () => {
    const { summaryPath } = workspace()
    const s = applyNarrationCaptions(summaryPath, { status: 'ok', words })
    const kinds = (cs: unknown) => (cs as Caption[]).map((c) => (c.narration ? 'n' : 'ai'))
    expect(kinds(captionsForRender(s.captions, op('replace')))).toEqual(['n', 'n'])
    expect(kinds(captionsForRender(s.captions, op('under')))).toContain('ai')
    expect(kinds(captionsForRender(s.captions, op('under')))).toContain('n')
    expect(kinds(captionsForRender(s.captions, op('keep', { muted: true })))).not.toContain('n')
    // Without recorded narration nothing changes.
    expect(captionsForRender(s.captions, undefined)).toBe(s.captions)
  })

  it('a failed transcription adds no cues: with replace the VTT is a valid empty one', () => {
    const { summaryPath } = workspace()
    const s = applyNarrationCaptions(summaryPath, { status: 'failed', words: [] })
    expect(s.captions).toEqual(baseSummary.captions)
    const vtt = toVtt(captionsForRender(s.captions, op('replace')), 9)
    expect(vtt).toBe('WEBVTT\n\n')
    expect(sniff(new TextEncoder().encode(vtt))).toBe('vtt')
    expect(applyNarrationCaptions(summaryPath, null).captions).toEqual(baseSummary.captions)
  })
})

describe('an empty captions.vtt', () => {
  it('finalize accepts it: the version is ready', async () => {
    const h = harness()
    const empty = new TextEncoder().encode(toVtt([], 2))
    h.deps.runner.defaultScript = ((orig) => (req) => {
      const s = orig(req)
      return {
        ...s,
        onTerminal: async () => {
          const { fixtureFiles, uploadAndManifest } = await import('./fakes.js')
          const a = await h.deps.store.getAttempt(req.requestId)
          const token = await runToken(h.deps, req.requestId)
          const m = await uploadAndManifest(h.deps.blobs, a?.jobId ?? '', req.requestId, {
            ...fixtureFiles(),
            'captions.vtt': empty,
          })
          await h.call('POST', `/api/internal/runs/${req.requestId}/done`, {
            origin: null,
            headers: { authorization: `Bearer ${token}` },
            body: m,
          })
        },
      }
    })(h.deps.runner.defaultScript)
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(4)
    const [a] = await h.attempts(video.id)
    expect(a?.stage).toBe('ready')
    const receipt = await h.deps.store.getReceipt(a?.id ?? '')
    expect(receipt?.manifest.files['captions.vtt']?.bytes).toBe(8)
  })
})
