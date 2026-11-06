// doctor's local-mode checks (bead va-p1th.5.13): what `video-agent local` needs on this machine. Informational: they
// never fail doctor, since someone who only uses a deployment needs none of them.
import { spawnSync } from 'node:child_process'
import { existsSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { cacheDir } from './workspace.js'

export interface LocalCheck {
  name: string
  ok: boolean
  detail: string
}

const which = (cmd: string) => {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
const versionOf = (cmd: string) =>
  spawnSync(cmd, ['--version'], { encoding: 'utf8' }).stdout.trim().split('\n')[0] ?? ''

export function localChecks(env: NodeJS.ProcessEnv, version: string): LocalCheck[] {
  const cache = cacheDir(env)
  const checks: LocalCheck[] = []
  const claude = which('claude')
  checks.push({
    name: 'agent',
    ok: Boolean(claude),
    detail: claude
      ? `Claude Code ${versionOf('claude')}`
      : 'Claude Code not found (https://claude.com/claude-code)',
  })
  if (process.platform === 'darwin') {
    const sb = which('sandbox-exec')
    checks.push({ name: 'sandbox', ok: Boolean(sb), detail: sb ? 'macOS Seatbelt' : 'sandbox-exec missing' })
  } else {
    const missing = ['bwrap', 'socat'].filter((c) => !which(c))
    checks.push({
      name: 'sandbox',
      ok: missing.length === 0,
      detail: missing.length
        ? `Install ${missing.join(' and ')} (Claude Code's sandbox needs them)`
        : 'bubblewrap',
    })
  }
  const runtime = join(cache, 'runtime', version)
  checks.push({
    name: 'runtime',
    ok: true,
    detail: existsSync(join(runtime, '.installed'))
      ? `installed at ${runtime}`
      : 'installed on the first local run',
  })
  const ffmpeg = join(cache, 'agent-kit-home', '.local', 'bin', 'ffmpeg')
  checks.push({
    name: 'ffmpeg',
    ok: true,
    detail: existsSync(ffmpeg)
      ? `pinned copy at ${ffmpeg}`
      : which('ffmpeg')
        ? `${which('ffmpeg')} (the first local run installs a pinned copy)`
        : 'installed on the first local run',
  })
  const python = ['python3.13', 'python3.12', 'python3.11', 'python3.10'].find((p) => which(p))
  checks.push({
    name: 'python',
    ok: Boolean(python),
    detail: python ? `${versionOf(python)} (for --voice)` : 'No Python 3.10 to 3.13: --voice is unavailable',
  })
  try {
    const s = statfsSync(existsSync(cache) ? cache : (env.HOME ?? '/'))
    const gb = (s.bavail * s.bsize) / 1024 ** 3
    checks.push({
      name: 'disk',
      ok: gb >= 3,
      detail: `${gb.toFixed(1)} GB free (local mode needs about 2 GB)`,
    })
  } catch {
    // No free-space figure on this platform.
  }
  return checks
}
