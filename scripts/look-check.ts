// Checks looks (plan 2026-11-04-looks §9). One line per problem, `look:<id>: <problem>`, then exit 1.
//   npm run look:check [--static] [id…]        (every look in looks/ when no id; looks/_template as a template)
// --static runs only what needs no browser (the Netlify build runs this). Without it (CI), each example also goes
// through the pinned `hyperframes check` in a temp project, which needs Chrome; with no browser it stops and says so.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkLookBrowser, NoBrowserError, type BrowserCheckOptions } from './lib/look-browser.js'
import { checkLookStatic } from './lib/look-static.js'
import { pinnedHyperframesVersion, repoRoot } from './lib/run-tools.js'

export interface LookCheckResult {
  looks: string[]
  problems: string[]
}

/** The look ids under `looksDir` (folders, _template included, dot folders skipped). */
export function lookIds(looksDir: string): string[] {
  if (!existsSync(looksDir)) return []
  return readdirSync(looksDir)
    .filter((n) => !n.startsWith('.') && statSync(join(looksDir, n)).isDirectory())
    .sort()
}

/** Checks `ids` (every look when empty). With `browser`, each example also goes through hyperframes check. */
export function runLookCheck(
  looksDir: string,
  ids: string[],
  hyperframesVersion: string,
  browser?: Omit<BrowserCheckOptions, 'hyperframesVersion'>,
): LookCheckResult {
  const looks = ids.length ? ids : lookIds(looksDir)
  const problems: string[] = []
  for (const id of looks) {
    const dir = join(looksDir, id)
    if (!existsSync(dir)) {
      problems.push(`look:${id}: there's no folder looks/${id}`)
      continue
    }
    for (const p of checkLookStatic(dir, { hyperframesVersion, template: id === '_template' }))
      problems.push(`look:${id}: ${p}`)
    if (!browser || !existsSync(join(dir, 'example', 'index.html'))) continue
    const started = Date.now()
    const found = checkLookBrowser(dir, { ...browser, hyperframesVersion })
    console.error(
      JSON.stringify({ step: 'hf-check', look: id, errors: found.length, ms: Date.now() - started }),
    )
    for (const p of found) problems.push(`look:${id}: ${p}`)
  }
  return { looks, problems }
}

if (process.argv[1]?.endsWith('look-check.ts')) {
  const started = Date.now()
  const args = process.argv.slice(2)
  const staticOnly = args.includes('--static')
  const ids = args.filter((a) => !a.startsWith('--'))
  const hyperframesVersion = pinnedHyperframesVersion()
  let result: LookCheckResult
  try {
    result = runLookCheck(
      join(repoRoot, 'looks'),
      ids,
      hyperframesVersion,
      staticOnly ? undefined : { repoRoot },
    )
  } catch (e) {
    if (!(e instanceof NoBrowserError)) throw e
    console.error(
      `look:check: ${e.message} Install Chrome (npx playwright install chromium) or run with --static.`,
    )
    process.exit(1)
  }
  const { looks, problems } = result
  for (const p of problems) console.log(p)
  console.error(
    JSON.stringify({
      step: 'look-check',
      static: staticOnly,
      looks,
      problems: problems.length,
      ms: Date.now() - started,
    }),
  )
  if (problems.length) process.exit(1)
  if (!looks.length) console.log('look:check: no looks found.')
  else console.log(`look:check: ${looks.length} look${looks.length === 1 ? '' : 's'} OK`)
}
