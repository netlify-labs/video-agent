// Length limits and trimming for briefs. The API takes at most 4,000 characters of prompt (CreateVideoSchema,
// ReviseSchema, RemixSchema), so text from GitHub gets at most 3,000 and the fixed text, the user's own words and the
// reference line get the rest (docs/plans/2026-11-04-github-action.md §3.6).

export const MAX_PROMPT = 4000
export const MIN_CREATE_PROMPT = 10
export const GITHUB_BUDGET = 3000
export const MAX_TITLE = 120

const ELLIPSIS = '…'

/** Collapses runs of blank lines and trims each line's end. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** One line, at most `max` characters, ending in "…" when cut (at a word boundary when there is one). */
export function trimLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  if (max <= 1) return one.slice(0, Math.max(0, max))
  const cut = one.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}${ELLIPSIS}`
}

/**
 * At most `max` characters, cut at the last paragraph boundary that fits (then a line, then a word), ending in "…"
 * when cut. Returns "" when not even a few words fit.
 */
export function trimAtParagraph(text: string, max: number): string {
  const t = tidy(text)
  if (t.length <= max) return t
  if (max < 20) return ''
  const room = t.slice(0, max - 1)
  for (const sep of ['\n\n', '\n']) {
    const i = room.lastIndexOf(sep)
    if (i >= max * 0.5) return `${room.slice(0, i).trimEnd()}\n${ELLIPSIS}`
  }
  const space = room.lastIndexOf(' ')
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}${ELLIPSIS}`
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'go.sum',
  'mix.lock',
  'Podfile.lock',
  'flake.lock',
])
const TEST_PATH =
  /(^|\/)(tests?|__tests__|__mocks__|specs?|e2e|fixtures|testdata)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py|rb)$/i
const GENERATED_PATH =
  /(^|\/)(dist|build|out|generated|__generated__|vendor|node_modules|__snapshots__)\/|\.(min\.(js|css)|map|snap)$|\.generated\./i
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svgz|psd|mp4|mov|webm|mp3|wav|ogg|m4a|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|wasm|exe|dll|so|dylib|bin|dat|db|sqlite)$/i
const DOTENV = /(^|\/)\.env(\.|$)/

/** Why a changed file is left out of a brief, or null when it's kept. */
export function excludedBecause(path: string): 'test' | 'lockfile' | 'generated' | 'binary' | 'env' | null {
  const name = path.split('/').at(-1) ?? path
  if (DOTENV.test(path)) return 'env'
  if (LOCKFILES.has(name)) return 'lockfile'
  if (BINARY.test(path)) return 'binary'
  if (GENERATED_PATH.test(path)) return 'generated'
  if (TEST_PATH.test(path)) return 'test'
  return null
}

/** Commit subjects without merge commits, duplicates (ignoring case) or blank ones, in order. */
export function dedupeCommits(subjects: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of subjects) {
    const s = (raw.split('\n')[0] ?? '').trim()
    if (!s || /^Merge (pull request|branch|remote-tracking branch|commit)\b/i.test(s)) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** Joins items with `sep` until the next one would pass `max`; says how many were left out. */
export function joinWithin(items: string[], sep: string, max: number): { text: string; shown: number } {
  let text = ''
  let shown = 0
  for (const item of items) {
    const next = shown === 0 ? item : `${text}${sep}${item}`
    if (next.length > max) break
    text = next
    shown++
  }
  return { text, shown }
}
