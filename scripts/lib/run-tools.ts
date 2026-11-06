// Helpers shared by render-job.ts and prepare-run.ts (run inside Agent Runner runs).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveFiles } from '../../src/lib/bundle-manifest.js'
import { NARRATION_SRC } from '../../src/lib/contract.js'
import { NARRATION_RUN_DIR, narrationPaths, readNarrationInputs } from './narration-inputs.js'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The pinned HyperFrames version: package.json `netlifyAgent.hyperframes.version` (the looks scripts check against it). */
export const pinnedHyperframesVersion = () =>
  (
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      netlifyAgent: { hyperframes: { version: string } }
    }
  ).netlifyAgent.hyperframes.version

export const log = (step: string, fields: Record<string, unknown> = {}) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), step, ...fields }))
}

export class StepError extends Error {}

/** A CLI's `main().catch(…)`: prints `<prefix><message>` to stderr and exits 1. */
export const exitOnError =
  (prefix = '') =>
  (e: unknown) => {
    console.error(`${prefix}${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

/**
 * tar arguments for an archive of video/: exactly the files the bundle manifest counts (no dependencies, caches,
 * renders, feedback stills or library media, which runs download by reference), less the reference files render-job
 * uploads on their own (the narration bus). The file list is written next to `out`, so tar and the manifest can't
 * disagree about what a composition is.
 */
export function videoTarArgs(out: string): string[] {
  assertNoTakesInVideo()
  const list = `${out}.files`
  writeFileSync(
    list,
    archiveFiles(join(repoRoot, 'video'))
      .map((f) => `video/${f}\n`)
      .join(''),
  )
  return ['-czf', out, '-C', repoRoot, '-T', list]
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Raw narration takes never enter video/ (plan 2026-11-02 §6.3): prepare-run hydrates them into .va-run/narration/,
 * outside it, and this refuses a video/ that holds a byte-identical copy of one anyway (a stored original, its
 * hydrated WAV or a clean copy) or a link into .va-run/. Files are compared by size first, so only same-size files
 * are hashed. The bus is exempt when it is the one narration.ts wrote (its receipt digest): a bypassed single-clip
 * bus can equal its take, and the bus is meant to be shared. render-job and every archive (videoTarArgs) call it.
 */
export function assertNoTakesInVideo(root = repoRoot): void {
  const p = narrationPaths(root)
  if (!existsSync(p.dir)) return
  const bySize = new Map<number, Set<string>>()
  const forbid = (bytes: number, sha: string) => bySize.set(bytes, (bySize.get(bytes) ?? new Set()).add(sha))
  for (const t of readNarrationInputs(root)?.takes ?? []) forbid(t.bytes, t.sha256)
  const walk = (d: string, each: (full: string) => void) => {
    if (existsSync(d))
      for (const name of readdirSync(d).sort()) {
        const full = join(d, name)
        const st = lstatSync(full)
        if (st.isDirectory()) walk(full, each)
        else each(full)
      }
  }
  for (const d of [p.fetch, p.src, p.clean])
    walk(d, (f) => {
      if (lstatSync(f).isFile()) forbid(lstatSync(f).size, sha256File(f))
    })
  let busSha: string | undefined
  try {
    busSha = (JSON.parse(readFileSync(p.receipt, 'utf8')) as { bus?: { sha256?: string } }).bus?.sha256
  } catch {
    busSha = undefined
  }
  const runDir = realpathSync(p.dir)
  const video = join(root, 'video')
  const bad: string[] = []
  const check = (d: string) => {
    if (!existsSync(d)) return
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      const rel = relative(video, full).split(sep).join('/')
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        const target = existsSync(full) ? realpathSync(full) : null // dangling: nothing to copy
        if (target && (target === runDir || target.startsWith(runDir + sep))) bad.push(rel)
      } else if (st.isDirectory()) {
        if (name !== 'node_modules') check(full)
      } else if (st.isFile() && bySize.has(st.size)) {
        const sha = sha256File(full)
        if (bySize.get(st.size)?.has(sha) && !(rel === NARRATION_SRC && sha === busSha)) bad.push(rel)
      }
    }
  }
  check(video)
  if (bad.length)
    throw new StepError(
      `video/ holds a copy of a recorded narration take: ${bad.map((b) => `video/${b}`).join(', ')}. Raw takes stay in ${NARRATION_RUN_DIR}/ and must never be archived or previewed. Delete the copy, then try again.`,
    )
}

export function which(cmd: string): string | null {
  const r = spawnSync('sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' })
  const out = r.stdout.trim()
  return r.status === 0 && out ? out : null
}

/** The netlify CLI isn't on PATH in non-interactive shells inside runs; look in the usual places. */
export function netlifyCli(): string[] {
  const found = which('netlify')
  if (found) return [found]
  for (const p of [
    '/opt/buildhome/node-deps/node_modules/.bin/netlify',
    '/opt/buildhome/.netlify-cli/bin/netlify',
    resolve(repoRoot, 'node_modules/.bin/netlify'),
  ]) {
    if (existsSync(p)) return [p]
  }
  return ['npx', '-y', 'netlify-cli']
}

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): string {
  try {
    return execFileSync(cmd, args, {
      cwd: opts.cwd ?? repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string }
    throw new StepError(
      `${cmd} ${args.slice(0, 3).join(' ')} failed: ${(err.stderr || err.stdout || err.message).trim().slice(-2000)}`,
    )
  }
}

/** Like run(), but streams output to `onOutput` as it arrives (for long renders that report progress). */
export function runStreaming(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; onOutput?: (chunk: string) => void } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (b: Buffer) => {
      const s = b.toString('utf8')
      tail = (tail + s).slice(-8000)
      opts.onOutput?.(s)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 15 * 60_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new StepError(`${cmd} failed to start: ${e.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(tail)
      else
        reject(
          new StepError(
            `${cmd} ${args.slice(0, 3).join(' ')} failed (${signal ?? `exit ${code}`}): ${tail.trim().slice(-2000)}`,
          ),
        )
    })
  })
}

export async function withRetries<T>(what: string, n: number, fn: () => Promise<T> | T): Promise<T> {
  let last: unknown
  for (let i = 1; i <= n; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      log('retry', { what, attempt: i, error: e instanceof Error ? e.message.slice(0, 300) : String(e) })
      if (i < n) await new Promise((r) => setTimeout(r, 2000 * i))
    }
  }
  throw last instanceof Error ? last : new StepError(String(last))
}

/**
 * Writes a generated file, or with `check` exits 1 when the committed one (a missing one counts) differs from `out`.
 * The messages name the file as `label`; `hint` says how to regenerate it.
 */
export function writeOrCheck(
  file: string,
  out: string,
  o: { check: boolean; label: string; hint: string },
): void {
  if (!o.check) {
    writeFileSync(file, out)
    console.log(`Wrote ${file}`)
    return
  }
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // missing counts as stale
  }
  if (current !== out) {
    console.error(`${o.label} is stale. ${o.hint}`)
    process.exit(1)
  }
  console.log(`${o.label} is up to date.`)
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a?.startsWith('--')) {
      const v = argv[i + 1]
      out[a.slice(2)] = v && !v.startsWith('--') ? (i++, v) : 'true'
    }
  }
  return out
}
