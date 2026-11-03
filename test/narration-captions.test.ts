// Narration captions (plan 2026-11-02 §6.6, bead va-2qq.3.13): grouping (2 x 42 characters, pauses over 300 ms,
// punctuation, 1-6 s), stable ids, the audible-track matrix, validate() accepting the new cue kind, the run step
// writing summary.json (and its failure fallback), and the empty captions.vtt a narrated version without cues gets,
// which finalize accepts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validate, type Caption, type Summary } from '../src/lib/contract.js'
import { sniff } from '../src/lib/media/mp4.js'
import {
  audibleCaptions,
  CUE_LINE_CHARS,
  cueId,
  groupWords,
  type CueWord,
  type NarrationCue,
} from '../src/lib/narration-captions.js'
import type { NarrationTracks } from '../src/lib/timeline.js'
import { toVtt } from '../scripts/lib/captions.js'
import { applyNarrationCaptions, captionsForRender } from '../scripts/lib/narration-captions.js'
import { narrationPaths } from '../scripts/lib/narration-inputs.js'
import { harness, PROMPT } from './helpers.js'

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

  function workspace(mode: NarrationTracks['aiVoice']['mode']) {
    const root = tmp()
    mkdirSync(join(root, 'video'), { recursive: true })
    const summaryPath = join(root, 'video', 'summary.json')
    writeFileSync(summaryPath, JSON.stringify(baseSummary))
    const p = narrationPaths(root)
    mkdirSync(p.dir, { recursive: true })
    writeFileSync(p.manifest, JSON.stringify({ v: 1, op: { tracks: tracks(mode) } }))
    return { root, summaryPath }
  }
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Summary

  it('writes the cues and the audible rule into summary.json, idempotently', () => {
    const { summaryPath } = workspace('replace')
    const first = applyNarrationCaptions(summaryPath, { status: 'ok', words }, { tracks: tracks('replace') })
    expect(first.cues).toHaveLength(2)
    const s = read(summaryPath)
    expect(s.title).toBe('Org webhooks')
    expect(s.captions?.every((c) => c.narration)).toBe(true)
    applyNarrationCaptions(summaryPath, { status: 'ok', words }, { tracks: tracks('replace') })
    expect(read(summaryPath).captions).toEqual(s.captions)
    expect(validate(html, read(summaryPath))).toEqual([])
  })

  it('a failed transcription adds no cues: with replace nothing is left, and the VTT is a valid empty one', () => {
    const { root, summaryPath } = workspace('replace')
    applyNarrationCaptions(summaryPath, { status: 'failed', words: [] }, { tracks: tracks('replace') })
    const s = read(summaryPath)
    expect(s.captions).toEqual([])
    const vtt = toVtt(captionsForRender(root, s.captions), 9)
    expect(vtt).toBe('WEBVTT\n\n')
    expect(sniff(new TextEncoder().encode(vtt))).toBe('vtt')
  })

  it('under keeps the AI cues when transcription failed', () => {
    const { summaryPath } = workspace('under')
    applyNarrationCaptions(summaryPath, null, { tracks: tracks('under') })
    expect(read(summaryPath).captions).toEqual(baseSummary.captions)
  })

  it('render-job applies the rule even if the caption step never ran; without narration it changes nothing', () => {
    const { root } = workspace('replace')
    expect(captionsForRender(root, baseSummary.captions)).toEqual([])
    expect(captionsForRender(tmp(), baseSummary.captions)).toBe(baseSummary.captions)
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
          const token = /--token (\S+)/.exec(req.prompt)?.[1]
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
