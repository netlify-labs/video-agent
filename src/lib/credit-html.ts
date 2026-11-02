// The credit line for CC BY media, as HTML: shared by the embed snippet (src/domain/videos.ts) and the public share
// page (netlify/edge-functions/public.ts), so it has no imports. Every value is escaped, and only http(s) URLs link.

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
