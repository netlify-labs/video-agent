// The optional look fields of a brand kit's brand.json: colours for the web app's two schemes, the colour of text
// on the accent, and font stacks. Every value ends up in the web app's CSS, so each is checked here and anything
// that isn't a plain hex colour or a plain font list is dropped (the app then keeps its neutral default for it).

export type BrandLookInput = {
  onPrimaryColor?: unknown
  primaryHoverColor?: unknown
  backgroundLight?: unknown
  textOnLight?: unknown
  backgroundDark?: unknown
  backgroundDarkAlt?: unknown
  textOnDark?: unknown
  fonts?: unknown
}

export type BrandLook = {
  /** Text and icons on a fill of the primary colour. With it, the primary button is filled with the brand colour. */
  onPrimary: string | null
  primaryHover: string | null
  light: { ground: string; text: string } | null
  dark: { ground: string; well: string | null; text: string } | null
  fonts: { text: string | null; heading: string | null; mono: string | null }
}

/** `#rrggbb` (or `#rgb`), lower-cased as `#rrggbb`; anything else is null. */
export function hexColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{3}$/.test(s)) return s.replace(/[0-9a-f]/g, (c) => c + c)
  return null
}

/** A CSS font-family list of plain names (letters, digits, spaces, quotes, commas, hyphens); anything else is null. */
export function fontStack(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > 300 || !/^[\w\s"',-]+$/.test(s)) return null
  // Quotes must pair up, or the value would swallow the rest of the declaration.
  if ((s.match(/"/g)?.length ?? 0) % 2 || (s.match(/'/g)?.length ?? 0) % 2) return null
  return s
}

export function brandLook(brand: BrandLookInput): BrandLook {
  const lightGround = hexColor(brand.backgroundLight)
  const lightText = hexColor(brand.textOnLight)
  const darkGround = hexColor(brand.backgroundDark)
  const darkText = hexColor(brand.textOnDark)
  const fonts = (brand.fonts && typeof brand.fonts === 'object' ? brand.fonts : {}) as Record<string, unknown>
  return {
    onPrimary: hexColor(brand.onPrimaryColor),
    primaryHover: hexColor(brand.primaryHoverColor),
    // A scheme needs both its background and its text; half a pair could be unreadable on the default other half.
    light: lightGround && lightText ? { ground: lightGround, text: lightText } : null,
    dark:
      darkGround && darkText
        ? { ground: darkGround, well: hexColor(brand.backgroundDarkAlt), text: darkText }
        : null,
    fonts: { text: fontStack(fonts.text), heading: fontStack(fonts.heading), mono: fontStack(fonts.mono) },
  }
}
