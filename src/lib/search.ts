// Library search: the words a query is split into. Every word must match somewhere (any case).

/** At most 8 words of at most 100 characters each, so a pasted paragraph can't build a huge query. */
export function searchWords(q: string | null | undefined): string[] {
  return (q ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((w) => w.slice(0, 100))
}
