// The frame math (contract-core.ts) and the scoped relayout (redo a scene, plan §4.5): frozen beats keep their
// durations verbatim, starts and totals follow, and with nothing scoped it agrees with the editor's relayout.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyDucking,
  applyEdits,
  attr,
  load,
  relayoutScoped,
  save,
  validate,
  walk,
  type Caption,
} from './contract.js'
import { FPS, fmt, frames, layoutBeats, layoutScoped, shiftCues, voiceFits } from './contract-core.js'

const music = readFileSync(new URL('../../test/fixtures/contract1-music/index.html', import.meta.url), 'utf8')

/** The music fixture with these beat durations, laid out as an author wrote them (plain sums, never relaid). */
function authored(durations: Record<string, string>) {
  const d = load(music)
  let t = 0
  for (const b of [...walk(d.root)].filter((e) => attr(e, 'data-va-beat') !== null)) {
    const id = attr(b, 'data-va-beat') ?? ''
    const dur = durations[id] ?? '3'
    for (const a of b.attrs) {
      if (a.name === 'data-start') a.value = fmt(t)
      if (a.name === 'data-duration' || a.name === 'data-va-authored-duration') a.value = dur
    }
    for (const v of [...walk(b)].filter((e) => attr(e, 'data-va-kind') === 'video'))
      for (const a of v.attrs) if (a.name === 'data-duration') a.value = dur
    t += Number(dur)
  }
  for (const e of [d.root, ...[...walk(d.root)].filter((x) => attr(x, 'data-va-layer') !== null)])
    for (const a of e.attrs) if (a.name === 'data-duration') a.value = fmt(t)
  applyDucking(d)
  return save(d)
}
const beat = (html: string, id: string) => {
  const b = [...walk(load(html).root)].find((e) => attr(e, 'data-va-beat') === id)
  if (!b) throw new Error(`no beat ${id}`)
  return b
}

describe('layoutBeats (the editor rule)', () => {
  it('snaps cumulative ends: a non-aligned beat takes the rounding, and later beats keep their lengths', () => {
    const { beats, total } = layoutBeats([3.85, 3, 3])
    expect(beats.map((b) => [fmt(b.start), fmt(b.duration)])).toEqual([
      ['0', '3.866667'],
      ['3.866667', '3'],
      ['6.866667', '3'],
    ])
    expect(fmt(total)).toBe('9.866667')
    // Two half-frame beats: the second absorbs the first's rounding instead of adding a frame.
    expect(layoutBeats([3.85, 3.85]).beats.map((b) => fmt(b.duration))).toEqual(['3.866667', '3.833333'])
  })
})

describe('layoutScoped', () => {
  it('keeps every duration and starts each beat at the plain sum before it', () => {
    const { beats, total } = layoutScoped([
      { id: 'a', duration: 3.85, scoped: false },
      { id: 'b', duration: frames(6.37), scoped: true },
      { id: 'c', duration: 2.2, scoped: false },
    ])
    expect(beats.map((b) => [fmt(b.start), fmt(b.duration)])).toEqual([
      ['0', '3.85'],
      ['3.85', '6.366667'],
      ['10.216667', '2.2'],
    ])
    expect(fmt(total)).toBe('12.416667')
  })

  it('refuses, naming the beat, a scoped length that is not whole frames or any length that is not positive', () => {
    expect(() => layoutScoped([{ id: 'features', duration: 6.37, scoped: true }])).toThrow(
      /Beat "features" must last whole frames \(6\.37s isn't\)/,
    )
    expect(() => layoutScoped([{ id: 'intro', duration: 0, scoped: false }])).toThrow(
      /Beat "intro" needs a positive/,
    )
  })
})

describe('relayoutScoped', () => {
  it('keeps frozen durations byte for byte around a lengthened scoped beat', () => {
    const parent = authored({ intro: '3.85', demo: '5', outro: '2.2' })
    expect(validate(parent)).toEqual([])
    const d = load(parent)
    const demo = [...walk(d.root)].find((e) => attr(e, 'data-va-beat') === 'demo')!
    for (const a of demo.attrs) if (a.name === 'data-duration') a.value = fmt(frames(6.37))
    relayoutScoped(d, new Set(['demo']))
    const out = save(d)
    expect(attr(beat(out, 'intro'), 'data-duration')).toBe('3.85')
    expect(attr(beat(out, 'outro'), 'data-duration')).toBe('2.2')
    expect(attr(beat(out, 'demo'), 'data-start')).toBe('3.85')
    expect(attr(beat(out, 'outro'), 'data-start')).toBe('10.216667')
    expect(attr(load(out).root, 'data-duration')).toBe('12.416667')
    for (const l of [...walk(load(out).root)].filter((e) => attr(e, 'data-va-layer') !== null))
      expect(attr(l, 'data-duration')).toBe('12.416667')
    // The scoped beat's video slot follows it; nothing inside a frozen beat moved.
    const slot = [...walk(beat(out, 'demo'))].find((e) => attr(e, 'data-va-kind') === 'video')!
    expect(attr(slot, 'data-duration')).toBe('6.366667')
    expect(validate(out)).toEqual([])
    // The ducking lane is what applyDucking makes of the result.
    const again = load(out)
    applyDucking(again)
    expect(save(again)).toBe(out)
  })

  it('with nothing scoped on a frame-aligned composition, gives the same bytes as the editor relayout', () => {
    const { html } = applyEdits(music, { title: 't', summary: 's', captions: [] }, [])
    const d = load(music)
    relayoutScoped(d, new Set())
    expect(save(d)).toBe(html)
  })

  it('refuses a scoped beat that is not whole frames, naming it', () => {
    const d = load(authored({ demo: '5' }))
    const demo = [...walk(d.root)].find((e) => attr(e, 'data-va-beat') === 'demo')!
    for (const a of demo.attrs) if (a.name === 'data-duration') a.value = '6.37'
    expect(() => relayoutScoped(d, new Set(['demo']))).toThrow(/Beat "demo" must last whole frames/)
  })
})

describe('shiftCues and voiceFits', () => {
  const cues: Caption[] = [
    {
      start: 1.23456,
      end: 2.5,
      text: 'a',
      beat: 'intro',
      textId: 'intro-title',
      beatStart: 1.23456,
      beatEnd: 2.5,
    },
    { start: 4, end: 5.1, text: 'spoken', beat: 'outro', voice: true, beatStart: 0, beatEnd: 1.1 },
  ]

  it('keeps exact times with no delta and moves by exactly the delta otherwise, without re-snapping', () => {
    expect(shiftCues(cues, 0)).toEqual(cues)
    expect(shiftCues(cues, 0)[0]).not.toBe(cues[0])
    const moved = shiftCues(cues, 1.383333)
    expect(moved.map((c) => [c.start, c.end])).toEqual([
      [2.617893, 3.883333],
      [5.383333, 6.483333],
    ])
    // Beat-relative times and everything else stay.
    expect(moved[0]).toMatchObject({ beatStart: 1.23456, textId: 'intro-title' })
    expect(moved[1]).toMatchObject({ voice: true })
  })

  it('lets a voice-over end up to half a frame past its beat', () => {
    expect(voiceFits(3, 0, 3)).toBe(true)
    expect(voiceFits(3, 0.5, 2.5 + 0.4 / FPS)).toBe(true)
    expect(voiceFits(3, 0.5, 2.5 + 0.6 / FPS)).toBe(false)
  })
})
