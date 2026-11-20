import { describe, expect, it } from 'vitest'
import { brandLook, fontStack, hexColor } from './brand-look.js'

describe('brand look', () => {
  it('reads the look fields of a brand kit', () => {
    expect(
      brandLook({
        onPrimaryColor: '#131619',
        primaryHoverColor: '#2BD8E6',
        backgroundLight: '#f7f6f4',
        textOnLight: '#131619',
        backgroundDark: '#1b1a17',
        backgroundDarkAlt: '#131619',
        textOnDark: '#f7f6f4',
        fonts: { text: '"Systemia", system-ui, "Helvetica", sans-serif', mono: '"IBM Plex Mono", monospace' },
      }),
    ).toEqual({
      onPrimary: '#131619',
      primaryHover: '#2bd8e6',
      light: { ground: '#f7f6f4', text: '#131619' },
      dark: { ground: '#1b1a17', well: '#131619', text: '#f7f6f4' },
      fonts: {
        text: '"Systemia", system-ui, "Helvetica", sans-serif',
        heading: null,
        mono: '"IBM Plex Mono", monospace',
      },
    })
  })

  it('is empty for a kit with only a name and a colour', () => {
    expect(brandLook({})).toEqual({
      onPrimary: null,
      primaryHover: null,
      light: null,
      dark: null,
      fonts: { text: null, heading: null, mono: null },
    })
  })

  it('drops a scheme that has only half its pair', () => {
    expect(brandLook({ backgroundLight: '#ffffff', textOnDark: '#ffffff' })).toMatchObject({
      light: null,
      dark: null,
    })
  })

  it('accepts only plain hex colours', () => {
    expect(hexColor('#ABC')).toBe('#aabbcc')
    expect(hexColor(' #01D4E5 ')).toBe('#01d4e5')
    for (const bad of ['red', '#12345', 'rgb(0,0,0)', '#fff;background:url(x)', 7, null, undefined])
      expect(hexColor(bad)).toBeNull()
  })

  it('accepts only plain font lists', () => {
    expect(fontStack("'Inter', system-ui")).toBe("'Inter', system-ui")
    for (const bad of [
      '',
      'x; background: url(https://example.com)',
      'a}body{display:none',
      '"Unclosed, serif',
      'url(x)',
      'a'.repeat(301),
      3,
    ])
      expect(fontStack(bad)).toBeNull()
  })
})
