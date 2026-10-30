import { createTheme, type MantineColorsTuple } from '@mantine/core'
import { contextMeta } from '../../src/generated/context'

/** A 10-shade Mantine palette from the brand's primary color (context/brand.json). */
function palette(hex: string): MantineColorsTuple {
  const n = parseInt(hex.replace('#', ''), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
  const mix = (t: number, to: number) => rgb.map((c) => Math.round(c + (to - c) * t))
  const toHex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  const steps = [0.9, 0.75, 0.6, 0.4, 0.2, 0, -0.15, -0.3, -0.45, -0.6]
  return steps.map((s) => toHex(s >= 0 ? mix(s, 255) : mix(-s, 0))) as unknown as MantineColorsTuple
}

export const theme = createTheme({
  primaryColor: 'brand',
  colors: { brand: palette(contextMeta.primaryColor) },
  primaryShade: { light: 6, dark: 5 },
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontFamilyMonospace: 'ui-monospace, "SF Mono", Menlo, monospace',
  headings: { fontWeight: '650' },
  defaultRadius: 'md',
  cursorType: 'pointer',
})

export const brand = contextMeta
