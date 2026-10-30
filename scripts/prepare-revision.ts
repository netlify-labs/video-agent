// Run first in a revision run: restore video/ to the parent version's composition.
//   npx tsx scripts/prepare-revision.ts --attempt <id> --source <jobId>/v<n>.tar.gz --sha256 <hex>
// Never falls back to the template: on any failure it exits non-zero and the agent must stop.
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { StepError, log, netlifyCli, parseArgs, repoRoot, run, sha256File, withRetries } from './lib/run-tools.js'

async function main() {
  const { attempt, source, sha256 } = parseArgs(process.argv.slice(2))
  if (!attempt || !source || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new StepError('Usage: prepare-revision.ts --attempt <id> --source <key> --sha256 <hex>')
  }
  const tmp = join(repoRoot, '.render', `${attempt}-source`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const archive = join(tmp, 'source.tar.gz')
  const [bin, ...pre] = netlifyCli() as [string, ...string[]]
  await withRetries('download source', 4, () => run(bin, [...pre, 'blobs:get', 'sources', source, '--output', archive], { timeoutMs: 5 * 60_000 }))
  const actual = sha256File(archive)
  if (actual !== sha256) throw new StepError(`The saved composition doesn't match its hash (got ${actual}). Stop and report this.`)
  run('tar', ['-tzf', archive]) // validates the archive before touching video/
  rmSync(join(repoRoot, 'video'), { recursive: true, force: true })
  run('tar', ['-xzf', archive, '-C', repoRoot])
  log('restored', { source, sha256 })
  console.log(`Restored video/ from ${source}. Continue with the revision.`)
}

main().catch((e: unknown) => {
  console.error(`prepare-revision failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
