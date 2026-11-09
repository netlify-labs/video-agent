// Optional preview variants render-job makes next to the required outputs: small WebP/AVIF posters and a short muted
// hover clip. Versions rendered before them, or on a runner whose ffmpeg lacks an encoder, have some or none.
// No imports: the edge functions (Deno) use this file too.

export const PREVIEW_FILES = {
  'poster-480.avif': 'image/avif',
  'poster-960.avif': 'image/avif',
  'poster-480.webp': 'image/webp',
  'poster-960.webp': 'image/webp',
  'clip.webm': 'video/webm',
  'clip.mp4': 'video/mp4',
} as const
export type PreviewFile = keyof typeof PREVIEW_FILES
export const PREVIEW_NAMES = Object.keys(PREVIEW_FILES) as PreviewFile[]

export const isPreviewFile = (name: string): name is PreviewFile => Object.hasOwn(PREVIEW_FILES, name)

/** A variant larger than this is dropped (the clip is a few hundred KB at most). */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

/** The tiny blurred placeholder: a base64 WebP or JPEG data URI, small enough to inline in every DTO. */
export const MAX_LQIP_CHARS = 2048
export const isLqip = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= MAX_LQIP_CHARS &&
  /^data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)

/** What finalize records for a version: the variants it stored, with sizes, and the placeholder. */
export interface Previews {
  files: Partial<Record<PreviewFile, { bytes: number }>>
  lqip: string | null
}

/** Checks a variant's magic bytes against its name. */
export function sniffPreview(name: PreviewFile, b: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  switch (PREVIEW_FILES[name]) {
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    case 'image/avif':
      return ascii(4, 8) === 'ftyp' && ascii(8, 40).includes('avif')
    case 'video/webm':
      return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3
    case 'video/mp4':
      return ascii(4, 8) === 'ftyp'
  }
}
