// The CLI's half of the render broker (scripts/lib/render-broker.ts): render-job, inside the agent's
// sandbox, asks for the render with .render/<attempt>/render-request.json, and this renders video.mp4 with the
// workspace's pinned hyperframes, outside the sandbox, so the agent's shell never needs the loopback. The page it renders
// goes through the render guard (render-guard.ts): no requests to this machine or its network but the render's own.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REQUEST, RESULT, PROGRESS, writeJson } from '../../../../scripts/lib/render-broker.js'
import { RenderProgressReporter } from '../../../../scripts/lib/render-progress.js'
import { agentEnv } from './agent.js'
import { startRenderGuard, writeChromeWrapper, type Guard } from './render-guard.js'
import type { Log } from './workspace.js'

/** Renders one request when it arrives; resolves when the run is over (signal) or the render is done. */
export function serveRenders(o: {
  renderDir: string
  ws: string
  env: NodeJS.ProcessEnv
  log: Log
  signal: AbortSignal
  pollMs?: number
}): Promise<void> {
  return new Promise((resolve) => {
    let busy = false
    const timer = setInterval(() => {
      if (busy || o.signal.aborted) return
      const request = join(o.renderDir, REQUEST)
      if (!existsSync(request) || existsSync(join(o.renderDir, RESULT))) return
      busy = true
      const t = Date.now()
      let quality = 'standard'
      try {
        quality = (JSON.parse(readFileSync(request, 'utf8')) as { quality?: string }).quality ?? quality
      } catch {
        // A half-written request: the default quality.
      }
      if (!/^[a-z]+$/.test(quality)) quality = 'standard'
      o.log('local.render_started', { quality })
      const progress = new RenderProgressReporter(
        (pct) => {
          writeJson(join(o.renderDir, PROGRESS), { pct })
        },
        Date.now,
        0,
        1,
      )
      void guarded(o, quality, progress, t).then(() => {
        clearInterval(timer)
        resolve()
      })
    }, o.pollMs ?? 500)
    o.signal.addEventListener(
      'abort',
      () => {
        if (!busy) {
          clearInterval(timer)
          resolve()
        }
      },
      { once: true },
    )
  })
}

/**
 * The Chrome hyperframes renders with: `browser ensure` finds or downloads chrome-headless-shell as its render does
 * (`browser path` alone would settle for a system Chrome, which on Linux aborts under the workspace's deep TMPDIR, and
 * the agent's own `hyperframes check` then has no headless shell either).
 */
function chromePath(ws: string, env: NodeJS.ProcessEnv): string | null {
  const opts = { cwd: join(ws, 'video'), env: agentEnv(env), encoding: 'utf8' as const, timeout: 5 * 60_000 }
  spawnSync('npx', ['hyperframes', 'browser', 'ensure'], opts)
  const r = spawnSync('npx', ['hyperframes', 'browser', 'path'], opts)
  const path = r.stdout.trim().split('\n').pop() ?? ''
  return r.status === 0 && path.startsWith('/') && existsSync(path) ? path : null
}

/** One render through the guard; fails closed when the guard can't be set up. */
async function guarded(
  o: { renderDir: string; ws: string; env: NodeJS.ProcessEnv; log: Log; signal: AbortSignal },
  quality: string,
  progress: RenderProgressReporter,
  t: number,
): Promise<void> {
  const fail = (error: string) => {
    writeJson(join(o.renderDir, RESULT), { ok: false, error })
    o.log('local.render_done', { ok: false, error, ms: Date.now() - t })
  }
  const chrome = chromePath(o.ws, o.env)
  if (!chrome) return fail("Couldn't find hyperframes' Chrome to render with (npx hyperframes browser path).")
  let pgid: number | null = null
  let guard: Guard
  try {
    guard = await startRenderGuard({ getPgid: () => pgid, log: o.log })
  } catch (e) {
    return fail(`The render guard didn't start: ${e instanceof Error ? e.message : String(e)}`)
  }
  const wrapper = join(o.ws, '.va', 'chrome-guarded')
  writeChromeWrapper(wrapper, chrome, guard.port)
  let tail = ''
  // A short temp dir on the host: Chrome's profile goes under TMPDIR, and on Linux its singleton socket path must fit
  // the 108-byte limit, which the workspace's own .tmp is too deep for.
  const tmp = mkdtempSync(join(tmpdir(), 'va-render-'))
  // Its own process group: the guard allows only the loopback ports this group listens on (the asset server).
  const child = spawn(
    'npx',
    ['hyperframes', 'render', '--quality', quality, '--output', join(o.renderDir, 'video.mp4')],
    {
      cwd: join(o.ws, 'video'),
      env: { ...agentEnv(o.env), TMPDIR: tmp, HYPERFRAMES_BROWSER_PATH: wrapper },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  pgid = child.pid ?? null
  const onChunk = (b: Buffer) => {
    const s = b.toString('utf8')
    tail = (tail + s).slice(-4000)
    progress.line(s)
  }
  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)
  const stop = () => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }
  o.signal.addEventListener('abort', stop, { once: true })
  const code = await new Promise<number | null>((r) => child.on('close', r))
  o.signal.removeEventListener('abort', stop)
  progress.end()
  await guard.close()
  rmSync(tmp, { recursive: true, force: true })
  const ok = code === 0 && existsSync(join(o.renderDir, 'video.mp4'))
  const error = ok ? undefined : tail.trim().slice(-1500)
  writeJson(join(o.renderDir, RESULT), ok ? { ok } : { ok, error })
  o.log('local.render_done', {
    ok,
    code,
    blocked: guard.blocked.length,
    ms: Date.now() - t,
    ...(ok ? {} : { error }),
  })
}
