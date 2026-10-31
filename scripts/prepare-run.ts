// Run first when the prompt says so: sets video/ up from the run manifest the server wrote for this attempt.
//   npx tsx scripts/prepare-run.ts --job <jobId> --attempt <id> --manifest <sha256>
// The manifest lives in the sources store at <jobId>/runs/<attempt>.json and must match the hash in the prompt.
// Only keys inside it are followed. Revisions restore the parent's source archive; render-unchanged runs restore
// a frozen bundle and verify its canonical file manifest. Never falls back to the template: on any failure it
// exits non-zero and the agent must stop. Writes the verified manifest to .render/run-manifest.json for render-job.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleManifest } from '../src/lib/bundle-manifest.js'
import { runManifestKey, verifyRunManifest, type RunManifest } from '../src/lib/run-manifest.js'
import {
  StepError,
  log,
  netlifyCli,
  parseArgs,
  repoRoot,
  run,
  sha256File,
  withRetries,
} from './lib/run-tools.js'

async function download(key: string, to: string) {
  const [bin, ...pre] = netlifyCli() as [string, ...string[]]
  await withRetries(`download ${key}`, 4, () =>
    run(bin, [...pre, 'blobs:get', 'sources', key, '--output', to], { timeoutMs: 5 * 60_000 }),
  )
}

/** Unpacks a verified archive over <root>/video (the archive holds video/…). */
function restoreArchive(root: string, archive: string, sha256: string, what: string) {
  const actual = sha256File(archive)
  if (actual !== sha256)
    throw new StepError(`The saved ${what} doesn't match its hash (got ${actual}). Stop and report this.`)
  const listing = run('tar', ['-tzf', archive]) // validates the archive before touching video/
  for (const entry of listing.split('\n').filter(Boolean))
    if (!entry.startsWith('video/') || entry.split('/').includes('..'))
      throw new StepError(`The saved ${what} has an unexpected entry (${entry}). Stop and report this.`)
  rmSync(join(root, 'video'), { recursive: true, force: true })
  run('tar', ['-xzf', archive, '-C', root])
}

/** Restores what the manifest lists. `root` and `fetch` are injectable for tests. */
export async function prepare(
  m: RunManifest,
  opts: { tmp: string; root?: string; fetch?: (key: string, to: string) => Promise<void> },
) {
  const { tmp, root = repoRoot, fetch = download } = opts
  if (m.source) {
    const archive = join(tmp, 'source.tar.gz')
    await fetch(m.source.key, archive)
    restoreArchive(root, archive, m.source.sha256, 'composition')
    log('restored', { kind: 'source', key: m.source.key, parentN: m.source.parentN })
  }
  if (m.bundle) {
    const archive = join(tmp, 'bundle.tar.gz')
    await fetch(m.bundle.key, archive)
    restoreArchive(root, archive, m.bundle.sha256, 'bundle')
    const actual = bundleManifest(join(root, 'video')).hash
    if (actual !== m.bundle.manifestHash)
      throw new StepError(
        `The restored bundle's files don't match its manifest (got ${actual}). Stop and report this.`,
      )
    log('restored', { kind: 'bundle', key: m.bundle.key, manifestHash: actual })
  }
}

async function main() {
  const { job, attempt, manifest: sha } = parseArgs(process.argv.slice(2))
  if (!job || !attempt || !sha || !/^[0-9a-f]{64}$/.test(sha))
    throw new StepError('Usage: prepare-run.ts --job <jobId> --attempt <id> --manifest <sha256>')
  const tmp = join(repoRoot, '.render', `${attempt}-prepare`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const local = join(tmp, 'run.json')
  await download(runManifestKey(job, attempt), local)
  let m: RunManifest
  try {
    m = verifyRunManifest(readFileSync(local, 'utf8'), { attemptId: attempt, sha256: sha })
  } catch (e) {
    throw new StepError(`${e instanceof Error ? e.message : String(e)} Stop and report this.`)
  }
  if (m.jobId !== job) throw new StepError('The run manifest is for a different video. Stop and report this.')
  log('manifest', { kind: m.kind, source: Boolean(m.source), bundle: Boolean(m.bundle) })
  await prepare(m, { tmp })
  writeFileSync(join(repoRoot, '.render', 'run-manifest.json'), JSON.stringify(m))
  console.log(
    m.kind === 'revision'
      ? `Restored video/ from version ${m.source?.parentN}. Continue with the revision.`
      : 'video/ is ready. Continue.',
  )
}

if (process.argv[1]?.endsWith('prepare-run.ts'))
  main().catch((e: unknown) => {
    console.error(`prepare-run failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
