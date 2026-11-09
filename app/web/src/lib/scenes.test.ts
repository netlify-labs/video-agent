import { describe, expect, it } from 'vitest'
import {
  beatAt,
  EVERY_REASON,
  HELD_REASON,
  MAX_PICKS,
  MAX_REASON,
  pickable,
  pinnedScenes,
  redidLabel,
  sceneChipLabel,
  scopedStart,
  type Beat,
} from './scenes'

const beats: Beat[] = [
  { id: 'hook', label: 'Hook', start: 0, duration: 4 },
  { id: 'features', label: 'Features', start: 4, duration: 6 },
  { id: 'end', label: null, start: 10, duration: 2.5 },
]
const held: Beat[] = [...beats, { id: 'va-hold', label: null, start: 12.5, duration: 3 }]
const ids = (n: number): Beat[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: null, start: i, duration: 1 }))

describe('beatAt', () => {
  it('finds the later scene at a boundary, the first at 0 and the last at or past the end', () => {
    expect(beatAt(beats, 0)?.id).toBe('hook')
    expect(beatAt(beats, 3.99)?.id).toBe('hook')
    expect(beatAt(beats, 4)?.id).toBe('features')
    expect(beatAt(beats, 12.5)?.id).toBe('end')
    expect(beatAt(beats, 99)?.id).toBe('end')
    expect(beatAt(held, 13)?.id).toBe('end')
    expect(beatAt([], 1)).toBeNull()
  })
})

describe('sceneChipLabel', () => {
  it('numbers from 1 and shows m:ss times, the id when there is no label', () => {
    expect(sceneChipLabel(1, beats[1] as Beat)).toBe('2. Features · 0:04–0:10')
    expect(sceneChipLabel(2, beats[2] as Beat)).toBe('3. end · 0:10–0:12')
    expect(sceneChipLabel(0, { id: 'long', label: 'Long', start: 59.5, duration: 65 })).toBe(
      '1. Long · 0:59–2:04',
    )
  })
})

describe('pickable', () => {
  it('never shows the held frame and disables the scene it holds', () => {
    const chips = pickable(held, [])
    expect(chips.map((c) => c.beat.id)).toEqual(['hook', 'features', 'end'])
    expect(chips.map((c) => c.disabled)).toEqual([null, null, HELD_REASON])
    // With the last one held, picking every other scene is fine.
    expect(pickable(held, ['hook']).map((c) => c.disabled)).toEqual([null, null, HELD_REASON])
  })

  it('disables the last unpicked scene when all but one are picked', () => {
    const chips = pickable(beats, ['hook', 'end'])
    expect(chips.map((c) => [c.picked, c.disabled])).toEqual([
      [true, null],
      [false, EVERY_REASON],
      [true, null],
    ])
  })

  it('allows at most 20 picks', () => {
    const many = ids(25)
    const twenty = many.slice(0, MAX_PICKS).map((b) => b.id)
    const chips = pickable(many, twenty)
    expect(chips.filter((c) => c.picked)).toHaveLength(MAX_PICKS)
    expect(chips.filter((c) => c.disabled === MAX_REASON)).toHaveLength(5)
    expect(pickable(many, twenty.slice(1)).every((c) => c.disabled === null)).toBe(true)
  })
})

describe('labels and refusals', () => {
  it('says which scenes a version redid', () => {
    expect(redidLabel({ beats: [{ id: 'features', label: 'Features' }] })).toBe('Redid Features')
    expect(
      redidLabel({
        beats: [
          { id: 'hook', label: 'Hook' },
          { id: 'features', label: 'Features' },
          { id: 'end', label: null },
        ],
      }),
    ).toBe('Redid Hook, Features and end')
  })
})

describe('pinnedScenes', () => {
  const five: Beat[] = [
    { id: 'hook', label: 'Hook', start: 0, duration: 2 },
    { id: 'problem', label: null, start: 2, duration: 2 },
    { id: 'demo', label: 'Demo', start: 4, duration: 2 },
    { id: 'proof', label: null, start: 6, duration: 2 },
    { id: 'end', label: null, start: 8, duration: 2 },
  ]
  const ids5 = (times: (number | null)[]) => pinnedScenes(five, times)?.beats.map((b) => b.id) ?? null

  it('maps pins to distinct scenes in order, a boundary to the later scene', () => {
    expect(ids5([5, 1, 4.5])).toEqual(['hook', 'demo'])
    expect(ids5([4])).toEqual(['demo'])
  })

  it('is on by default under half the scenes, off from half', () => {
    expect(pinnedScenes(five, [1, 5])?.byDefault).toBe(true)
    expect(pinnedScenes(five, [1, 5, 7])?.byDefault).toBe(false)
  })

  it('refuses an unpinned comment, every scene and the held one', () => {
    expect(ids5([1, null])).toBeNull()
    expect(ids5([])).toBeNull()
    expect(ids5([1, 3, 5, 7, 9])).toBeNull()
    expect(pinnedScenes(held, [13])).toBeNull()
    expect(pinnedScenes(held, [11])).toBeNull()
    expect(pinnedScenes(held, [1, 5])?.beats.map((b) => b.id)).toEqual(['hook', 'features'])
  })
})

describe('scopedStart', () => {
  it('is where the first redone scene starts in the scoped version, null for a whole one', () => {
    expect(scopedStart({ beats, scope: { beats: [{ id: 'end' }, { id: 'features' }] } })).toBe(4)
    expect(scopedStart({ beats, scope: null })).toBeNull()
    expect(scopedStart({ beats: null, scope: { beats: [{ id: 'end' }] } })).toBeNull()
  })
})
