import { describe, expect, it } from 'vitest'
import {
  aspectNote,
  defaultLook,
  lookMark,
  looksForDemo,
  pickable,
  sortForTemplate,
  type Look,
} from './looks'

const look = (id: string, o: Partial<Look> = {}): Look => ({
  id,
  name: id,
  description: `${id} look`,
  tags: [],
  bestFor: [],
  aspects: ['16:9', '9:16', '1:1', '4:5'],
  engines: ['hyperframes'],
  recording: null,
  hash: `h_${id}`,
  enabled: true,
  preview: { mp4: null, poster: null },
  ...o,
})

describe('pickable', () => {
  it('hides looks an admin turned off', () => {
    expect(pickable([look('a'), look('b', { enabled: false })]).map((l) => l.id)).toEqual(['a'])
  })
})

describe('sortForTemplate', () => {
  it("puts the looks made for the plan's template first and keeps catalog order otherwise", () => {
    const looks = [
      look('clean', { bestFor: ['launch'] }),
      look('kinetic', { bestFor: ['social'] }),
      look('x'),
    ]
    expect(sortForTemplate(looks, 'social').map((r) => [r.look.id, r.fits])).toEqual([
      ['kinetic', true],
      ['clean', false],
      ['x', false],
    ])
    expect(sortForTemplate(looks).map((r) => r.look.id)).toEqual(['clean', 'kinetic', 'x'])
    expect(sortForTemplate(looks, null).every((r) => !r.fits)).toBe(true)
  })
})

describe('aspectNote', () => {
  it('names the shapes when the look does not cover every one', () => {
    expect(aspectNote(look('a'))).toBeNull()
    expect(aspectNote({ aspects: ['16:9', '9:16'] })).toBe('Made for 16:9 and 9:16')
    expect(aspectNote({ aspects: ['16:9', '9:16', '1:1'] })).toBe('Made for 16:9, 9:16 and 1:1')
    expect(aspectNote({ aspects: ['9:16'] })).toBe('Made for 9:16')
  })
})

describe('looksForDemo', () => {
  it('hides disabled looks, looks without HyperFrames and looks that hide recordings', () => {
    const looks = [
      look('clean'),
      look('off', { enabled: false }),
      look('remotion', { engines: ['remotion'] }),
      look('both', { engines: ['remotion', 'hyperframes'] }),
      look('norec', { recording: false }),
    ]
    expect(looksForDemo(looks).map((l) => l.id)).toEqual(['clean', 'both'])
  })
})

describe('defaultLook', () => {
  it('is the admin default while it is enabled, else none', () => {
    const looks = [look('clean'), look('kinetic', { enabled: false })]
    expect(defaultLook({ looks, default: 'clean' })?.id).toBe('clean')
    expect(defaultLook({ looks, default: 'kinetic' })).toBeNull()
    expect(defaultLook({ looks, default: null })).toBeNull()
    expect(defaultLook(undefined)).toBeNull()
  })
})

describe('lookMark', () => {
  it("marks the version's own look Current at the same hash and Updated at a newer one", () => {
    expect(lookMark(look('clean'), { id: 'clean', hash: 'h_clean' })).toBe('current')
    expect(lookMark(look('clean'), { id: 'clean', hash: 'h_old' })).toBe('updated')
    expect(lookMark(look('kinetic'), { id: 'clean', hash: 'h_clean' })).toBeNull()
    expect(lookMark(look('clean'), null)).toBeNull()
  })
})
