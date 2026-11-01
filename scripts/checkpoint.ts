// Best-effort milestone from inside a run (plan v2 §6 A2): tells the person watching what the agent is doing, and
// optionally sends a snapshot of video/ for the live preview.
//   npx tsx scripts/checkpoint.ts --attempt <id> --url <checkpoint url> --token <t> --message "Writing the end card" [--bundle]
// Never fails the run: any problem prints "checkpoint skipped: …" and exits 0. Sequence numbers come from a counter
// file in .render/, so a late post never replaces a newer one. render-job.ts reuses postCheckpoint for render %.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** A .tar.gz of video/ (no media bytes, caches, renders or stills), or null when it would be over 2 MB. */
function bundleVideo(attempt: string): string | null {
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
    const bundle = o.bundle ? bundleVideo(o.attempt) : null
    const res = await (o.fetchImpl ?? fetch)(o.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        seq: nextSeq(o.attempt),
        ...(o.message ? { message: o.message.slice(0, 500) } : {}),
        ...(o.renderPercent !== undefined ? { renderPercent: Math.round(o.renderPercent) } : {}),
        ...(bundle ? { bundle } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    return { ok: true, ...(o.bundle && !bundle ? { reason: 'bundle over 2 MB, sent without it' } : {}) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

async function main() {
  const { attempt, url, token, message, bundle } = parseArgs(process.argv.slice(2))
  if (!attempt || !url || !token || !message) {
    console.log(
      'checkpoint skipped: usage: checkpoint.ts --attempt <id> --url <url> --token <t> --message "…" [--bundle]',
    )
    return
  }
  const r = await postCheckpoint({ attempt, url, token, message, bundle: bundle === 'true' })
  log('checkpoint', { ok: r.ok, reason: r.reason })
  console.log(r.ok ? `checkpoint sent${r.reason ? ` (${r.reason})` : ''}` : `checkpoint skipped: ${r.reason}`)
}

if (process.argv[1]?.endsWith('checkpoint.ts')) void main()
