import { describe, expect, it } from 'vitest'
import { defaultTarget } from './add-target'

describe('defaultTarget', () => {
  it('offers Openverse music to Music, takes and recordings to Narration, the rest to the selected track', () => {
    expect(defaultTarget({ source: { name: 'openverse' }, role: null }, 'narration')).toBe('music')
    expect(defaultTarget({ source: null, role: 'narration-take' }, 'music')).toBe('narration')
    expect(defaultTarget({ source: null, role: 'narration-upload' }, 'music')).toBe('narration')
    expect(defaultTarget({ source: null, role: null }, 'music')).toBe('music')
    expect(defaultTarget({ source: null, role: null }, 'narration')).toBe('narration')
    expect(defaultTarget(null, 'music')).toBe('music')
  })
})
