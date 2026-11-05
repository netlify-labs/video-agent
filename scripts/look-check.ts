// Checks looks (plan 2026-11-04-looks §9). One line per problem, `look:<id>: <problem>`, then exit 1.
//   npm run look:check [--static] [id…]        (every look in looks/ when no id; looks/_template as a template)
// --static runs only what needs no browser (the Netlify build runs this). Without it, CI also runs the browser half:
// the example in a temp HyperFrames project through `hyperframes check` (task va-nifa.2.4).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkLookStatic } from './lib/look-static.js'
import { repoRoot } from './lib/run-tools.js'

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

export function runLookCheck(looksDir: string, ids: string[], hyperframesVersion: string): LookCheckResult {
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
  }
  return { looks, problems }
}

if (process.argv[1]?.endsWith('look-check.ts')) {
  const started = Date.now()
  const args = process.argv.slice(2)
  const staticOnly = args.includes('--static')
  const ids = args.filter((a) => !a.startsWith('--'))
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    netlifyAgent: { hyperframes: { version: string } }
  }
  const { looks, problems } = runLookCheck(join(repoRoot, 'looks'), ids, pkg.netlifyAgent.hyperframes.version)
  for (const p of problems) console.log(p)
  if (!staticOnly)
    console.error('look:check: the browser half (hyperframes check on each example) is not built yet.')
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
