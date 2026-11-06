// Best-effort milestone from inside a run (plan v2 §6 A2): tells the person watching what the agent is doing, and
// optionally sends a snapshot of video/ for the live preview.
//   npx tsx scripts/checkpoint.ts --attempt <id> --url <checkpoint url> --token <t> --message "Writing the end card" [--bundle]
// Never fails the run: any problem prints "checkpoint skipped: …" and exits 0. Sequence numbers come from a counter
// file in .render/, so a late post never replaces a newer one. render-job.ts reuses postCheckpoint for render %.
// Local mode passes a file: URL, a folder under <repoRoot>/.render/: each checkpoint is written there as <seq>.json
// with the same body (cli-and-sdk plan §7), because the sandboxed agent can't reach a server on the host.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log, parseArgs, repoRoot, videoTarArgs } from './lib/run-tools.js'

const BUNDLE_MAX = 2 * 1024 * 1024

function nextSeq(attempt: string): number {
  const dir = join(repoRoot, '.render')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `checkpoint-seq-${attempt}`)
  const n = existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1
  writeFileSync(file, String(n))
  return n
}

/** A file: URL's folder, only when it's inside <repoRoot>/.render/; anything else is refused. */
export function localFolder(url: string): string | null {
  if (!url.startsWith('file:')) return null
  const dir = resolve(fileURLToPath(url))
  if (!dir.startsWith(`${join(repoRoot, '.render')}${sep}`))
    throw new Error(`${dir} is outside ${join(repoRoot, '.render')}`)
  return dir
}

/** Writes JSON to `file` through a temp file and a rename, so a reader never sees half of it. */
export function writeAtomic(file: string, body: string) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, file)
}

/** A .tar.gz of video/ (no media bytes, caches, renders or stills), or null when it would be over 2 MB. */
function bundleVideo(attempt: string): string | null {
  mkdirSync(join(repoRoot, '.render'), { recursive: true })
  const out = join(repoRoot, '.render', `checkpoint-${attempt}.tar.gz`)
  execFileSync('tar', videoTarArgs(out))
  if (statSync(out).size > BUNDLE_MAX) return null
  return readFileSync(out).toString('base64')
}

export async function postCheckpoint(o: {
  attempt: string
  url: string
  token: string
  message?: string
  renderPercent?: number
  bundle?: boolean
  fetchImpl?: typeof fetch
}): Promise<{ ok: boolean; reason?: string }> {
  try {
    const t = Date.now()
    const folder = localFolder(o.url)
    const bundle = o.bundle ? bundleVideo(o.attempt) : null
    const seq = nextSeq(o.attempt)
    const body = JSON.stringify({
      seq,
      ...(o.message ? { message: o.message.slice(0, 500) } : {}),
      ...(o.renderPercent !== undefined ? { renderPercent: Math.round(o.renderPercent) } : {}),
      ...(bundle ? { bundle } : {}),
    })
    const skipped = o.bundle && !bundle ? { reason: 'bundle over 2 MB, sent without it' } : {}
    if (folder) {
      mkdirSync(folder, { recursive: true })
      writeAtomic(join(folder, `${seq}.json`), body)
      log('checkpoint.file_written', { attempt: o.attempt, seq, bundle: Boolean(bundle), ms: Date.now() - t })
      return { ok: true, ...skipped }
    }
    const res = await (o.fetchImpl ?? fetch)(o.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    return { ok: true, ...skipped }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

async function main() {
  const { attempt, url, token, message, bundle } = parseArgs(process.argv.slice(2))
  // A file: URL (local mode) needs no token.
  if (!attempt || !url || (!token && !url.startsWith('file:')) || !message) {
    console.log(
      'checkpoint skipped: usage: checkpoint.ts --attempt <id> --url <url> --token <t> --message "…" [--bundle]',
    )
    return
  }
  const r = await postCheckpoint({ attempt, url, token: token ?? '', message, bundle: bundle === 'true' })
  log('checkpoint', { ok: r.ok, reason: r.reason })
  console.log(r.ok ? `checkpoint sent${r.reason ? ` (${r.reason})` : ''}` : `checkpoint skipped: ${r.reason}`)
}

if (process.argv[1]?.endsWith('checkpoint.ts')) void main()
