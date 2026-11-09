// The credit line for CC BY media and the embed snippet, as HTML: shared by the publication DTO (app/server/domain/videos.ts)
// and the public share page and its oEmbed JSON (netlify/edge-functions/public.ts), so it has no imports. Every value
// is escaped, and only http(s) URLs link.

export interface CreditLine {
  role: string
  title: string
  creator: string | null
  creatorUrl: string | null
  licenseLabel: string
  licenseUrl: string | null
  sourceUrl: string | null
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function link(text: string, url: string | null) {
  if (!url || !/^https?:\/\//i.test(url)) return esc(text)
  return `<a href="${esc(url)}" rel="noopener" target="_blank">${esc(text)}</a>`
}

/** "Music: <Title> by <Creator>, <CC BY 4.0>", one line per credit joined by "; ". */
export function creditHtml(credits: CreditLine[]): string {
  return credits
    .map(
      (c) =>
        `${esc(c.role)}: ${link(c.title, c.sourceUrl)}${c.creator ? ` by ${link(c.creator, c.creatorUrl)}` : ''}, ${link(c.licenseLabel, c.licenseUrl)}`,
    )
    .join('; ')
}

/** The embed snippet: only the metadata loads until play, the box is sized before it does, and the poster is the
 * small WebP when the version has one. The MP4 is the only full-length file, so it is the one source. A version
 * with CC BY media carries its credit line as a caption, as the licence asks. */
export function embedHtml(
  base: string,
  webp: string | null,
  size: { width: number; height: number } | null,
  credits: CreditLine[],
): string {
  const box = size ? ` width="${size.width}" height="${size.height}" style="max-width:100%;height:auto"` : ''
  const video = `<video controls playsinline preload="metadata"${box} poster="${webp ?? `${base}.jpg`}"><source src="${base}.mp4" type="video/mp4"><track kind="captions" src="${base}.vtt" srclang="en" label="Captions"></video>`
  if (!credits.length) return video
  return `<figure style="margin:0">${video}<figcaption style="font:12px/1.4 system-ui,sans-serif;opacity:.8">${creditHtml(credits)}</figcaption></figure>`
}
