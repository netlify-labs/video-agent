// Audio already in the team library that matches a music search: shown above Openverse's results (and returned by
// search_music) so people reuse tracks they have, instantly, without asking Openverse.
import type { Deps } from '../deps.js'
import { mediaDto } from './media.js'
import { assertCan, type Principal } from './policy.js'
import type { MediaRow } from './types.js'

/** How many library items a search looks through, and the most it returns. */
const LIBRARY_SCAN = 500
const MAX_MATCHES = 8
// Words in almost every music search or title, which say nothing about the track.
const STOP_WORDS = new Set('a an and the of by for with music track song audio mp3 wav'.split(' '))

/** A search's words: lowercase, at least two characters, without the words every music search has. */
export function searchWords(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w)),
    ),
  ].slice(0, 8)
}

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** How many of the words start a word of the item's title, caption, filename or credit. */
function score(m: MediaRow, words: string[]) {
  const text = [m.filename, m.caption ?? '', m.sourceTitle ?? '', m.creator ?? ''].join(' ').toLowerCase()
  return words.filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w)}`, 'u').test(text)).length
}

/**
 * Ready audio in the library matching the search's words (title, caption, filename, creator or source title): those
 * matching every word first, then Openverse imports (licensed and credited), then more words matched, then newest.
 */
export async function libraryMatches(deps: Deps, p: Principal, q: string, limit = MAX_MATCHES) {
  assertCan(p, 'video:read')
  const words = searchWords(q)
  if (!words.length) return []
  const rows: MediaRow[] = []
  let before: { createdAt: string; id: string } | undefined
  while (rows.length < LIBRARY_SCAN) {
    // No includePendingOf: only ready items, the ones everyone in the team sees and a version can use.
    const page = await deps.store.listMedia({ kind: 'audio', before, limit: 100 })
    rows.push(...page.filter((m) => m.kind === 'audio' && m.status === 'ready' && !m.deletedAt))
    const last = page.at(-1)
    if (page.length < 100 || !last) break
    before = { createdAt: last.createdAt, id: last.id }
  }
  const ranked = rows
    .map((m) => ({ m, n: score(m, words) }))
    .filter((x) => x.n > 0)
    .sort(
      (a, b) =>
        Number(b.n === words.length) - Number(a.n === words.length) ||
        Number(b.m.source === 'openverse') - Number(a.m.source === 'openverse') ||
        b.n - a.n ||
        b.m.createdAt.localeCompare(a.m.createdAt),
    )
    .slice(0, Math.min(Math.max(limit, 1), 20))
  const usage = await deps.store.mediaUsage(ranked.map((x) => x.m.id))
  return Promise.all(ranked.map((x) => mediaDto(deps, p, x.m, usage)))
}
