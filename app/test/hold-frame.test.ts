// Hold the final frame (plan 2026-11-02 §2.5, §6.1 output limit, §6.3; docs/spikes.md S12): applyHoldFrame appends
// one data-va-hold beat showing a still of the last frame, bounded by the output limit, and removing it restores the
// composition; validate accepts exactly that beat, last; holdBeatOf finds it for the narration guard.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyEdits,
  applyHoldFrame,
  applyNarration,
  HOLD_BEAT,
  HOLD_STILL_SRC,
  holdBeatOf,
  load,
  read,
  save,
  validate,
  type Summary,
} from '../server/lib/contract.js'
import { SAMPLE_RATE, type NarrationOp } from '../server/lib/timeline.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
const html = fx('index.html')
const summary = JSON.parse(fx('summary.json')) as Summary
/** The fixture as the patcher lays it out (9 s: intro, demo, outro). */
const base = applyEdits(html, summary, []).html

const held = (seconds: number, from = base) => {
  const d = load(from)
  applyHoldFrame(d, seconds)
  return save(d)
}
const holdSection = (h: string) => /<section id="va-hold"[^]*?<\/section>/.exec(h)?.[0] ?? ''

describe('applyHoldFrame', () => {
  it('appends one still beat after the visuals; the root and layers span it, the beats before it stay', () => {
    const out = held(2)
    expect(validate(out, summary)).toEqual([])
    const c = read(load(out))
    expect(c.duration).toBe(11)
    expect(c.beats.map((b) => [b.id, b.start, b.duration])).toEqual([
      ['intro', 0, 3],
      ['demo', 3, 3],
      ['outro', 6, 3],
      [HOLD_BEAT, 9, 2],
    ])
    const hold = c.beats.at(-1)!
    expect(hold.texts).toEqual([])
    expect(hold.media).toEqual([])
    expect(holdBeatOf(load(out))).toEqual({ beat: HOLD_BEAT, start: 9, duration: 2 })
    expect(holdBeatOf(load(base))).toBeNull()
    const section = holdSection(out)
    expect(section).toContain('data-va-hold="2"')
    expect(section).toContain(`<img src="${HOLD_STILL_SRC}"`)
    expect(section).not.toContain('<script')
    expect(out).toMatch(/id="bg-glow"[^>]*data-duration="11"/)
    // Everything before the hold is the base's: the beats' markup is unchanged.
    for (const id of ['intro', 'demo', 'outro']) {
      const beat = (h: string) => new RegExp(`<section id="${id}"[^]*?</section>`).exec(h)?.[0]
      expect(beat(out)).toBe(beat(base))
    }
  })

  it('is deterministic, in whole frames, replaces an earlier hold, and 0 restores the composition', () => {
    expect(held(2)).toBe(held(2))
    // 1.51 s is 45.3 frames: 45 frames, 1.5 s.
    expect(holdBeatOf(load(held(1.51)))?.duration).toBe(1.5)
    const again = held(3, held(2))
    expect(holdBeatOf(load(again))).toEqual({ beat: HOLD_BEAT, start: 9, duration: 3 })
    expect(again.match(/data-va-hold=/g)).toHaveLength(1)
    expect(held(0, held(2))).toBe(base)
    expect(held(0, base)).toBe(base)
    expect(() => held(0.01)).toThrow('A held frame lasts at least one frame.')
  })

  it('stays within the output limit: base + 120 s, never over 15 minutes', () => {
    expect(holdBeatOf(load(held(120)))?.duration).toBe(120)
    expect(() => held(120.04)).toThrow(
      'Holding the last frame for 120.033333s would make the video 129.033333s; it can run to 129s at most.',
    )
    // A 13 min 26 s video (800 s of intro) can hold 94 s, to 15 minutes, and no more.
    const long = base.replace(
      'data-start="0" data-duration="3" data-va-authored-duration="3"',
      'data-start="0" data-duration="800" data-va-authored-duration="800"',
    )
    expect(holdBeatOf(load(held(94, long)))?.duration).toBe(94)
    expect(() => held(95, long)).toThrow('it can run to 900s at most.')
  })

  it('edits keep it valid: an earlier retime moves it, and it follows the visuals', () => {
    const out = applyEdits(held(2), summary, [{ op: 'retime', beat: 'demo', duration: 4 }])
    expect(out.composition.duration).toBe(12)
    expect(holdBeatOf(load(out.html))).toEqual({ beat: HOLD_BEAT, start: 10, duration: 2 })
    // The hold itself isn't retimed or moved by hand.
    expect(() => applyEdits(held(2), summary, [{ op: 'retime', beat: HOLD_BEAT, duration: 4 }])).toThrow(
      'The held frame must stay exactly as the editor writes it',
    )
    expect(() =>
      applyEdits(held(2), summary, [{ op: 'reorder', order: ['intro', 'demo', HOLD_BEAT, 'outro'] }]),
    ).toThrow('The held frame (data-va-hold) must be the last beat.')
    // Deleting it restores the base.
    expect(applyEdits(held(2), summary, [{ op: 'delete', beat: HOLD_BEAT }]).html).toBe(base)
  })

  it('with narration, the narration layer spans the hold too', () => {
    const op: NarrationOp = {
      op: 'narration',
      schema: 1,
      sampleRate: SAMPLE_RATE,
      clips: [],
      tracks: {
        narration: { volumeDb: 0, muted: false, solo: false },
        aiVoice: { mode: 'replace', volumeDb: -12 },
        music: { duck: true, duckDb: -12 },
        original: { muteAll: false },
      },
      cleanup: 'light',
    }
    const out = applyNarration(base, summary, op, new Map(), { holdSeconds: 1.5 }).html
    expect(read(load(out)).duration).toBe(10.5)
    expect(out).toMatch(/<audio id="va-narration"[^>]*data-duration="10.5"/)
    expect(holdBeatOf(load(out))).toEqual({ beat: HOLD_BEAT, start: 9, duration: 1.5 })
    // Without narration there's nothing to hold for.
    expect(
      holdBeatOf(load(applyNarration(base, summary, null, new Map(), { holdSeconds: 1.5 }).html)),
    ).toBeNull()
  })
})

describe('validate and the held frame', () => {
  const out = held(2)
  const section = holdSection(out)
  const problems = (h: string) => validate(h, summary)

  it('accepts exactly one, last, as written', () => {
    expect(section).not.toBe('')
    expect(problems(out)).toEqual([])
  })

  it('refuses two holds', () => {
    expect(problems(out.replace(section, section + section))).toContain(
      "There's more than one held frame (data-va-hold); keep one, as the last beat.",
    )
  })

  it('refuses a hold that is not last', () => {
    const moved = out.replace(section, '').replace('<section id="outro"', `${section}<section id="outro"`)
    expect(problems(moved)).toContain('The held frame (data-va-hold) must be the last beat.')
  })

  it('refuses a hold with text, a script, other media or another length', () => {
    const changed =
      'The held frame must stay exactly as the editor writes it: a still of the last frame, with no text, media or animation.'
    const withText = section.replace('<img ', '<h1 data-va-text="held-title">Hi</h1><img ')
    const withScript = section.replace(
      '</section>',
      "<script>vaBeat('va-hold', (tl, el) => { tl.to(el, { opacity: 0, duration: 1 }) })</script></section>",
    )
    const otherStill = section.replace(HOLD_STILL_SRC, 'assets/media/med_logo.svg')
    const longer = section.replace('data-duration="2"', 'data-duration="3"')
    const faded = section.replace('z-index:2147483647', 'z-index:2147483647;opacity:0.5')
    for (const bad of [withText, withScript, otherStill, faded])
      expect(problems(out.replace(section, bad))).toContain(changed)
    expect(problems(out.replace(section, longer))).toContain(changed)
  })

  it('keeps data-va-hold and the va-hold id for the held frame', () => {
    expect(problems(base.replace('id="bg-glow"', 'id="bg-glow" data-va-hold="1"'))).toContain(
      'Only the held-frame beat carries data-va-hold.',
    )
    const renamed = base
      .replace(
        'data-va-beat="outro" data-composition-id="outro"',
        'data-va-beat="va-hold" data-composition-id="va-hold"',
      )
      .replace("vaBeat('outro'", "vaBeat('va-hold'")
    expect(problems(renamed)).toContain('Beat id "va-hold" is kept for the held last frame.')
  })
})
