// The CLI's half of the render broker (scripts/lib/render-broker.ts; docs/spikes.md C2): render-job, inside the agent's
// sandbox, asks for the render with .render/<attempt>/render-request.json, and this renders video.mp4 with the
// workspace's pinned hyperframes, outside the sandbox, so the agent's shell never needs the loopback.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REQUEST, RESULT, PROGRESS, writeJson } from '../../../../scripts/lib/render-broker.js'
import { RenderProgressReporter } from '../../../../scripts/lib/render-progress.js'
import { agentEnv } from './agent.js'
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
      let tail = ''
      const child = spawn(
        'npx',
        ['hyperframes', 'render', '--quality', quality, '--output', join(o.renderDir, 'video.mp4')],
        { cwd: join(o.ws, 'video'), env: agentEnv(o.env), stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const onChunk = (b: Buffer) => {
        const s = b.toString('utf8')
        tail = (tail + s).slice(-4000)
        progress.line(s)
      }
      child.stdout.on('data', onChunk)
      child.stderr.on('data', onChunk)
      const stop = () => child.kill('SIGTERM')
      o.signal.addEventListener('abort', stop, { once: true })
      child.on('close', (code) => {
        o.signal.removeEventListener('abort', stop)
        progress.end()
        const ok = code === 0 && existsSync(join(o.renderDir, 'video.mp4'))
        writeJson(join(o.renderDir, RESULT), ok ? { ok } : { ok, error: tail.trim().slice(-1500) })
        o.log('local.render_done', { ok, code, ms: Date.now() - t })
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
