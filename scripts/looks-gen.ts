// Rewrites src/generated/looks.ts from looks/ (the build does this too; this is for commits, since CI typechecks and
// tests without a build).   npm run looks:gen
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLooks, LookBuildError, writeLooksModule } from './lib/looks.js'
import { repoRoot } from './lib/run-tools.js'

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  netlifyAgent: { hyperframes: { version: string } }
}
try {
  const entries = buildLooks({
    repoRoot,
    hyperframesVersion: pkg.netlifyAgent.hyperframes.version,
    writeArchives: false,
  })
  writeLooksModule(repoRoot, entries)
  console.log(`src/generated/looks.ts: ${entries.length} look${entries.length === 1 ? '' : 's'}`)
} catch (e) {
  if (!(e instanceof LookBuildError)) throw e
  console.error(e.message)
  process.exit(1)
}
