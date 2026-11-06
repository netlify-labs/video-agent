// Privacy mode's warnings (screen-final item 2): what the output check still read that looks private reaches the version
// from render-job's manifest as privacyNotes, kept only when well formed (known kinds, real times, one per kind a
// second, at most 50), and shows to people as "An email may still be readable at 0:12". Only hide strings fail.
import { describe, expect, it } from 'vitest'
import { privacyNotesOf, privacyWarningOf } from '../src/domain/demo-recording.js'

describe('privacy notes', () => {
  it('keeps known kinds at real times, one per kind a second, sorted', () => {
    const notes = privacyNotesOf(
      {
        noted: [
          { t: 12.4, kind: 'email' },
          { t: 12.9, kind: 'email' },
          { t: 3, kind: 'key' },
          { t: 5, kind: 'string' },
          { t: -1, kind: 'email' },
          { t: 99, kind: 'email' },
          { t: 'x', kind: 'card' },
          { t: 4, kind: 'nope' },
        ],
      },
      20,
    )
    console.log(JSON.stringify({ test: 'privacy-notes', kept: notes }))
    expect(notes).toEqual([
      { t: 3, kind: 'key' },
      { t: 12.4, kind: 'email' },
    ])
    expect(privacyNotesOf(undefined, 20)).toEqual([])
    expect(privacyNotesOf({ noted: 'x' }, 20)).toEqual([])
    const many = privacyNotesOf({ noted: Array.from({ length: 80 }, (_, i) => ({ t: i, kind: 'url' })) }, 100)
    expect(many).toHaveLength(50)
  })

  it('reads as a warning for people', () => {
    expect(privacyWarningOf({ t: 12.4, kind: 'email' })).toBe('An email may still be readable at 0:12')
    expect(privacyWarningOf({ t: 75, kind: 'card' })).toBe('A card number may still be readable at 1:15')
    expect(privacyWarningOf({ t: 0, kind: 'url' })).toBe('A URL may still be readable at 0:00')
  })
})
