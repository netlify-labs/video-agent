// Where the stem monitor's audio comes from (docs/plans/2026-11-02-record-your-own-voiceover.md §5.3, §8): stems from
// the edited draft's bundle through the existing preview capability (GET /api/v1/edits/{id}/preview, author-only for
// drafts; the link's directory serves every bundle file, so a stem's src resolves against it), and narration takes
// through their media row's scoped signed link (the audition's fetchTake). The preview link is short-lived: it is
// minted on first use and again shortly before it expires.
import { fetchClient } from '../../api/client'

export { fetchTake as signedTakeLoader } from '../../lib/use-narration-audition'

/** Mint a new link this long before the old one expires. */
const RENEW_EARLY_MS = 60_000

interface Link {
  url: string
  expiresAt: string
}

/** A stem loader over a preview link source (the draft's, or a ready version's). */
export function previewStemLoader(
  mint: () => Promise<Link | null>,
  now: () => number = () => Date.now(),
): (src: string) => Promise<ArrayBuffer> {
  let link: Promise<Link> | null = null
  let expires = 0
  const current = () => {
    if (!link || now() > expires - RENEW_EARLY_MS) {
      link = mint().then((l) => {
        if (!l) throw new Error("The draft's preview isn't available.")
        expires = Date.parse(l.expiresAt)
        return l
      })
      link.catch(() => {
        link = null
      })
    }
    return link
  }
  return async (src) => {
    const { url } = await current()
    const res = await fetch(new URL(src, url))
    if (!res.ok) throw new Error(`${src} didn't download (${res.status}).`)
    return res.arrayBuffer()
  }
}

/** Stems of an edit draft's current rev. */
export const draftStemLoader = (editId: string) =>
  previewStemLoader(async () => {
    const { data } = await fetchClient.GET('/api/v1/edits/{id}/preview', { params: { path: { id: editId } } })
    return data ?? null
  })
