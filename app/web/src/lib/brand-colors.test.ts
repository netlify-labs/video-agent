import { describe, expect, it } from 'vitest'
import { contrast, inkOn, mix, readable, shadeFor, shades } from './brand-colors'

describe('brand colours', () => {
  it('mixes two colours', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#f7f6f4', '#131619', 0)).toBe('#f7f6f4')
  })

  it('measures contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0)
    // Netlify sky on its warm page is a fill, not text.
    expect(contrast('#01d4e5', '#f7f6f4')).toBeLessThan(2)
  })

  it('makes an accent readable as text, and leaves one that already is', () => {
    const onLight = readable('#01d4e5', '#f7f6f4')
    expect(contrast(onLight, '#f7f6f4')).toBeGreaterThanOrEqual(4.5)
    expect(readable('#01d4e5', '#1b1a17')).toBe('#01d4e5')
  })

  it('picks the ink for a fill', () => {
    expect(inkOn('#01d4e5')).toBe('#111111')
    expect(inkOn('#1d1f20')).toBe('#ffffff')
  })

  it('keeps the colour at shade 5 and finds a readable shade', () => {
    const teal = shades('#14b8a6')
    expect(teal[5]).toBe('#14b8a6')
    expect(shadeFor(teal, '#f9fafb', 5)).toBe(7)
    const sky = shades('#01d4e5')
    expect(contrast(sky[shadeFor(sky, '#f7f6f4', 5)]!, '#f7f6f4')).toBeGreaterThanOrEqual(4.5)
  })
})
