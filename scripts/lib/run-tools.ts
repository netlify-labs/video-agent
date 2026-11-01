// Helpers shared by render-job.ts and prepare-run.ts (run inside Agent Runner runs).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compositionFiles } from '../../src/lib/bundle-manifest.js'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const log = (step: string, fields: Record<string, unknown> = {}) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), step, ...fields }))
}

export class StepError extends Error {}

/**
 * tar arguments for an archive of video/: exactly the files the bundle manifest counts (no dependencies, caches,
 * renders, feedback stills or library media, which runs download by reference). The file list is written next to
 * `out`, so tar and the manifest can't disagree about what a composition is.
 */
export function videoTarArgs(out: string): string[] {
  const list = `${out}.files`
  writeFileSync(
    list,
    compositionFiles(join(repoRoot, 'video'))
      .map((f) => `video/${f}\n`)
      .join(''),
  )
  return ['-czf', out, '-C', repoRoot, '-T', list]
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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
