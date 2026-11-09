// local --look (looks plan §4.13; bead va-nifa.5.3): a Look bundled with the CLI (<runtime>/looks/<id>/), or a look
// folder on disk, so a contributor can try a look before their pull request merges. The folder's look.json is checked
// and its run files archived exactly as the server's build archives them; prepare-run restores it into context/look/.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  buildLookArchive,
  lookJsonProblems,
  LookFileError,
  readLookRunFiles,
} from '../../../../app/server/lib/looks.js'
import { UsageError } from '../exit.js'

export interface LocalLook {
  id: string
  name: string
  /** The look/ archive, its sha256 and the hash of its files (what the run manifest carries). */
  bytes: Uint8Array
  sha256: string
  hash: string
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory()

/** The ids bundled with this CLI. */
export const bundledLooks = (runtime: string): string[] =>
  isDir(join(runtime, 'looks')) ? readdirSync(join(runtime, 'looks')).sort() : []

/** --look <id|path>: a path when it names a folder (or contains a slash), else a bundled id. */
export function resolveLocalLook(value: string, runtime: string): LocalLook {
  const asPath = value.includes('/') || value.startsWith('.') || isDir(resolve(value))
  const dir = asPath ? resolve(value) : join(runtime, 'looks', value)
  if (!isDir(dir)) {
    if (asPath) throw new UsageError(`--look ${value}: no such look folder.`)
    const ids = bundledLooks(runtime)
    throw new UsageError(
      `There's no Look called "${value}" in this CLI${ids.length ? ` (it has ${ids.join(', ')})` : ''}. Or pass a look folder: --look ./looks/<id>.`,
    )
  }
  let json: unknown
  try {
    json = JSON.parse(readFileSync(join(dir, 'look.json'), 'utf8'))
  } catch {
    throw new UsageError(`${dir} has no readable look.json: is it a look folder?`)
  }
  // A folder is checked against its own id (contributors may name the folder anything); a bundled look by its folder.
  const id = (json as { id?: unknown } | null)?.id
  const problems = lookJsonProblems(json, asPath && typeof id === 'string' ? id : basename(dir))
  if (problems.length)
    throw new UsageError(
      `--look ${value}: ${problems.join('; ')} (npm run look:check -- --static <id> says more).`,
    )
  let files: Map<string, Uint8Array>
  try {
    files = readLookRunFiles(dir)
  } catch (e) {
    if (e instanceof LookFileError) throw new UsageError(`--look ${value}: ${e.message}`)
    throw e
  }
  const a = buildLookArchive(files)
  const look = json as { id: string; name: string }
  return { id: look.id, name: look.name, bytes: a.bytes, sha256: a.sha256, hash: a.hash }
}
