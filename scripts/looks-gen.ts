// Rewrites app/server/generated/looks.ts from app/looks/ (the build does this too; this is for commits, since CI typechecks and
// tests without a build).   npm run looks:gen
import { buildLooks, LookBuildError, writeLooksModule } from './lib/looks.js'
import { pinnedHyperframesVersion, repoRoot } from './lib/run-tools.js'

const hyperframesVersion = pinnedHyperframesVersion()
try {
  const entries = buildLooks({ repoRoot, hyperframesVersion, writeArchives: false })
  writeLooksModule(repoRoot, entries)
  console.log(`app/server/generated/looks.ts: ${entries.length} look${entries.length === 1 ? '' : 's'}`)
} catch (e) {
  if (!(e instanceof LookBuildError)) throw e
  console.error(e.message)
  process.exit(1)
}
