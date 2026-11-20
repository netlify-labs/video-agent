// Colour maths for the theme: the brand kit gives a few colours (context/brand.json); the role tokens are worked
// out from them here, so any kit gets readable text and visible edges without listing every token.

type Rgb = readonly [number, number, number]

const rgb = (hex: string): Rgb => {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const hex = (c: readonly number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/** `a` moved `t` (0 to 1) of the way to `b`. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)]
  return hex(x.map((c, i) => c + ((y[i] ?? c) - c) * t))
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** `color`, moved toward black or white (away from `on`) only as far as it takes to reach `min` contrast on `on`. */
export function readable(color: string, on: string, min = 4.5): string {
  const to = luminance(on) > 0.4 ? '#000000' : '#ffffff'
  for (let t = 0; t <= 1; t += 0.02) {
    const c = mix(color, to, t)
    if (contrast(c, on) >= min) return c
  }
  return to
}

/** Near-black or white, whichever reads better on a fill of `fill`. */
export function inkOn(fill: string): string {
  return contrast('#111111', fill) >= contrast('#ffffff', fill) ? '#111111' : '#ffffff'
}

/** Ten shades of one colour, light to dark, with the colour itself at index 5 (a Mantine palette). */
export function shades(color: string): string[] {
  return [0.9, 0.75, 0.6, 0.4, 0.2, 0, -0.15, -0.3, -0.45, -0.6].map((s) =>
    s >= 0 ? mix(color, '#ffffff', s) : mix(color, '#000000', -s),
  )
}

/** The first shade from `from` up that reaches `min` contrast on `on`; the darkest if none does. */
export function shadeFor(palette: readonly string[], on: string, from: number, min = 4.5): number {
  const i = palette.findIndex((shade, n) => n >= from && contrast(shade, on) >= min)
  return i === -1 ? palette.length - 1 : i
}
