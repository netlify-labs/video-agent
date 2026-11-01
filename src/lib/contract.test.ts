// Editing contract v1 (plan v2 §8, §14 rules 18-20): the validator and the patcher on the spike S8 fixture.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyEdits, ContractError, load, read, validate, type EditOp, type Summary } from './contract.js'

const fx = (f: string) => readFileSync(new URL(`../../test/fixtures/contract1/${f}`, import.meta.url), 'utf8')
const html = fx('index.html')
const summary = JSON.parse(fx('summary.json')) as Summary

describe('contract validator', () => {
  it('accepts the fixture and reads its beats, texts, colours and slots', () => {
    expect(validate(html, summary)).toEqual([])
    const c = read(load(html))
    expect(c.duration).toBe(9)
    expect(c.beats.map((b) => [b.id, b.start, b.duration])).toEqual([
      ['intro', 0, 3],
      ['demo', 3, 3],
      ['outro', 6, 3],
    ])
    // data-va-label is read where the author gave one, and null elsewhere.
    expect(c.beats.map((b) => b.label)).toEqual(['Opening', null, null])
    expect(c.beats[0]?.texts).toEqual([
      { id: 'intro-kicker', text: 'Netlify', label: null },
      { id: 'intro-title', text: 'Org webhooks', label: 'Headline' },
    ])
    expect(c.colors).toMatchObject({ bg: '#0b0d10', accent: '#14b8a6' })
    expect(c.beats[1]?.media).toEqual([
      {
        slot: 'hero-clip',
        label: null,
        kind: 'video',
        src: 'assets/media/med_clip.mp4',
        beat: 'demo',
        fit: null,
      },
    ])
    expect(c.layers).toEqual(['glow'])
  })

  it.each([
    ['no marker', (h: string) => h.replace('data-va-contract="1"', ''), /data-va-contract="1"/],
    [
      'no adapter',
      (h: string) => h.replace('<script src="vendor/va-contract.js"></script>', ''),
      /va-contract\.js/,
    ],
    [
      'beat on another track',
      (h: string) =>
        h.replace(
          'data-start="3" data-duration="3" data-va-authored-duration="3" data-track-index="0"',
          'data-start="3" data-duration="3" data-va-authored-duration="3" data-track-index="2"',
        ),
      /must be on track 0/,
    ],
    [
      'gap between beats',
      (h: string) =>
        h.replace(
          'data-va-beat="outro" data-composition-id="outro" data-start="6"',
          'data-va-beat="outro" data-composition-id="outro" data-start="6.5"',
        ),
      /should start at 6s/,
    ],
    [
      'duplicate text id',
      (h: string) => h.replace('data-va-text="outro-cta"', 'data-va-text="intro-title"'),
      /used twice/,
    ],
    [
      'document selectors',
      (h: string) =>
        h.replace(
          'tl.from(el.querySelector(\'[data-va-text="outro-cta"]\')',
          "tl.from(document.querySelector('#title')",
        ),
      /not document/,
    ],
    [
      'cross-beat reference',
      (h: string) =>
        h.replace("vaBeat('outro', (tl, el) => {", "vaBeat('outro', (tl, el) => { tl.set('#intro', {})"),
      /refers to beat "intro"/,
    ],
    [
      'timed element outside beats',
      (h: string) =>
        h.replace(
          '<div id="bg-glow"',
          '<div id="stray" data-start="0" data-duration="2"></div><div id="bg-glow"',
        ),
      /neither a beat nor a layer/,
    ],
    [
      'layer too short',
      (h: string) =>
        h.replace(
          'data-va-layer="glow" data-start="0" data-duration="9"',
          'data-va-layer="glow" data-start="0" data-duration="5"',
        ),
      /span the whole video/,
    ],
    [
      'media outside assets/media',
      (h: string) => h.replace('src="assets/media/med_logo.svg"', 'src="https://cdn.example.com/logo.svg"'),
      /assets\/media/,
    ],
    [
      'wrong root duration',
      (h: string) =>
        h.replace(
          'data-va-contract="1" data-start="0" data-duration="9"',
          'data-va-contract="1" data-start="0" data-duration="12"',
        ),
      /add up to 9s/,
    ],
  ])('rejects %s', (_n, mutate, msg) => {
    expect(validate(mutate(html)).join(' ')).toMatch(msg)
  })

  it('rejects captions that point at the wrong beat', () => {
    const bad = { ...summary, captions: [{ ...summary.captions![0]!, beat: 'outro' }] }
    expect(validate(html, bad).join(' ')).toMatch(/doesn't match a text in beat "outro"/)
  })
})

describe('contract patcher', () => {
  it('sets text as text, never HTML, and updates the caption', () => {
    const out = applyEdits(html, summary, [{ op: 'text', id: 'intro-title', text: '<b>Webhooks</b> & more' }])
    expect(out.html).toContain('&lt;b&gt;Webhooks&lt;/b&gt; &amp; more')
    expect(out.summary.captions?.[0]?.text).toBe('<b>Webhooks</b> & more')
  })

  it('retimes by stretching: later beats shift, the root, layers, video slots and captions follow', () => {
    const out = applyEdits(html, summary, [{ op: 'retime', beat: 'intro', duration: 4.5 }])
    expect(out.composition.beats.map((b) => [b.id, b.start, b.duration])).toEqual([
      ['intro', 0, 4.5],
      ['demo', 4.5, 3],
      ['outro', 7.5, 3],
    ])
    expect(out.composition.duration).toBe(10.5)
    expect(out.html).toMatch(/data-va-layer="glow" data-start="0" data-duration="10.5"/)
    // Authored duration stays, so the adapter stretches the beat's own timeline by 1.5.
    expect(out.html).toMatch(/data-va-beat="intro"[^>]*data-va-authored-duration="3"/)
    expect(out.summary.captions?.map((c) => [c.start, c.end])).toEqual([
      [0.6, 4.5],
      [5, 7.5],
      [7.7, 10.5],
    ])
  })

  it('quantizes times to frames', () => {
    const out = applyEdits(html, summary, [{ op: 'retime', beat: 'demo', duration: 2.01 }])
    expect(out.composition.beats[1]?.duration).toBe(2)
    expect(out.composition.beats[2]?.start).toBe(5)
  })

  it('reorders and deletes beats, refusing to delete the last one', () => {
    const re = applyEdits(html, summary, [{ op: 'reorder', order: ['intro', 'outro', 'demo'] }])
    expect(re.composition.beats.map((b) => [b.id, b.start])).toEqual([
      ['intro', 0],
      ['outro', 3],
      ['demo', 6],
    ])
    expect(re.summary.captions?.map((c) => c.textId)).toEqual(['intro-title', 'outro-cta', 'demo-sub'])
    const del = applyEdits(html, summary, [{ op: 'delete', beat: 'demo' }])
    expect(del.composition.duration).toBe(6)
    expect(del.summary.captions?.map((c) => c.textId)).toEqual(['intro-title', 'outro-cta'])
    expect(() =>
      applyEdits(html, summary, [
        { op: 'delete', beat: 'demo' },
        { op: 'delete', beat: 'outro' },
        { op: 'delete', beat: 'intro' },
      ]),
    ).toThrow(/last beat/)
    expect(() => applyEdits(html, summary, [{ op: 'reorder', order: ['intro', 'demo'] }])).toThrow(
      /every beat once/,
    )
  })

  it('swaps a colour role only within the palette', () => {
    const out = applyEdits(html, summary, [{ op: 'color', role: 'accent', value: '#FF5A1F' }], {
      palette: ['#ff5a1f', '#14b8a6'],
    })
    expect(out.composition.colors.accent).toBe('#ff5a1f')
    expect(() =>
      applyEdits(html, summary, [{ op: 'color', role: 'accent', value: '#000000' }], {
        palette: ['#ff5a1f'],
      }),
    ).toThrow(/brand palette/)
    expect(() => applyEdits(html, summary, [{ op: 'color', role: 'nope', value: '#fff' }])).toThrow(
      /no colour role/,
    )
  })

  it('swaps media within its kind with an explicit fit; video slots stay muted', () => {
    const out = applyEdits(html, summary, [
      { op: 'media', slot: 'hero-clip', src: 'assets/media/med_other.mp4', kind: 'video', fit: 'contain' },
    ])
    expect(out.composition.beats[1]?.media[0]).toMatchObject({
      src: 'assets/media/med_other.mp4',
      fit: 'contain',
    })
    expect(out.html).toMatch(/<video[^>]*data-va-media="hero-clip"[^>]*muted/)
    expect(() =>
      applyEdits(html, summary, [
        { op: 'media', slot: 'logo', src: 'assets/media/x.mp4', kind: 'video', fit: 'cover' },
      ]),
    ).toThrow(/takes image media/)
    expect(() =>
      applyEdits(html, summary, [
        { op: 'media', slot: 'logo', src: '../../etc/passwd', kind: 'image', fit: 'cover' },
      ]),
    ).toThrow(/assets\/media/)
  })

  it('refuses to edit a composition that does not conform', () => {
    expect(() => applyEdits(html.replace('data-va-contract="1"', ''), summary, [])).toThrow(ContractError)
  })

  it('random edit sequences keep the composition valid and the timeline consistent', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (let round = 0; round < 60; round++) {
      let cur = { html, summary }
      for (let step = 0; step < 6; step++) {
        const beats = read(load(cur.html)).beats.map((b) => b.id)
        const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)] as T
        const ops: EditOp[] = [
          { op: 'retime', beat: pick(beats), duration: 0.5 + rnd() * 8 },
          { op: 'reorder', order: [...beats].sort(() => rnd() - 0.5) },
          { op: 'text', id: 'outro-cta', text: `Go ${round}.${step}` },
        ]
        if (beats.length > 1 && rnd() < 0.2)
          ops.push({ op: 'delete', beat: pick(beats.filter((b) => b !== 'outro')) })
        const next = applyEdits(cur.html, cur.summary, [pick(ops)])
        const c = next.composition
        const sum = c.beats.reduce((s, b) => s + b.duration, 0)
        expect(Math.abs(sum - c.duration)).toBeLessThan(1e-5)
        expect(validate(next.html, next.summary)).toEqual([])
        for (const cap of next.summary.captions ?? []) expect(cap.end).toBeLessThanOrEqual(c.duration + 1e-5)
        cur = next
      }
    }
  })
})
