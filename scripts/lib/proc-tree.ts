// An outer deadline that kills a whole process tree (docs/spikes.md S11). Killing the process group is not enough:
// in S11 `npm exec` and a worker survived a group SIGTERM, because npx and the tools it runs can start their own
// sessions. So the command runs detached (setsid: its own session and group), the tree under it is sampled while it
// runs (a child reparented to init after its parent dies keeps counting), and on the deadline every pid we saw gets
// SIGTERM, then SIGKILL after a grace period. The tree is read with one `ps -A -o pid=,ppid=` (Linux and macOS
// alike; /proc when there's no ps) and walked recursively from the leader.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

/** pid -> parent pid for every process (empty when neither ps nor /proc is readable). */
export function processTable(): Map<number, number> {
  const out = new Map<number, number>()
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  if (r.status === 0) {
    for (const line of r.stdout.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (pid !== undefined && ppid !== undefined && Number.isInteger(pid) && Number.isInteger(ppid))
        out.set(pid, ppid)
    }
    return out
  }
  if (!existsSync('/proc')) return out
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
      out.set(Number(d), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]))
    } catch {
      // It exited while we read it.
    }
  }
  return out
}

/** Every descendant of `root` (not root itself), walked recursively through the parent links. */
export function descendants(root: number, table = processTable()): number[] {
  const kids = new Map<number, number[]>()
  for (const [pid, ppid] of table) kids.set(ppid, [...(kids.get(ppid) ?? []), pid])
  const out: number[] = []
  const stack = [root]
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    for (const k of kids.get(pid) ?? []) {
      out.push(k)
      stack.push(k)
    }
  }
  return out
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone.
  }
}

export interface TreeResult {
  code: number | null
  signal: string | null
  /** Exit 0 within the deadline. */
  ok: boolean
  timedOut: boolean
  wallMs: number
  stdout: string
  stderrTail: string
  /** Pids we saw under the command that were still alive afterwards and got killed (any outcome). */
  reaped: number[]
}

export interface TreeOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  deadlineMs: number
  /** Between SIGTERM and SIGKILL (default 3 s). */
  graceMs?: number
  /** How often the tree is sampled while it runs (default 500 ms). */
  sampleMs?: number
  /** Keep stdout up to this many bytes (default 16 MiB). */
  maxStdout?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Runs `cmd` under the deadline and resolves when it and everything it started are gone. Never rejects: a spawn
 * failure is code 127. Callers read `timedOut` and `ok`.
 */
export async function runTree(cmd: string, args: string[], opts: TreeOptions): Promise<TreeResult> {
  const started = Date.now()
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const leader = child.pid ?? -1
  const max = opts.maxStdout ?? 16 * 1024 * 1024
  let stdout = ''
  let stderrTail = ''
  child.stdout.on('data', (b: Buffer) => {
    if (stdout.length < max) stdout += b.toString('utf8')
  })
  child.stderr.on('data', (b: Buffer) => {
    stderrTail = (stderrTail + b.toString('utf8')).slice(-8000)
  })
  const seen = new Set<number>()
  const sample = () => {
    if (leader > 0) for (const p of descendants(leader)) seen.add(p)
  }
  const sampler = setInterval(sample, opts.sampleMs ?? 500)
  const kill: { timedOut: boolean; done: Promise<void> | null } = { timedOut: false, done: null }
  const killTree = async () => {
    kill.timedOut = true
    sample()
    const all = [leader, ...seen].filter((p) => p > 0)
    signal(-leader, 'SIGTERM')
    for (const p of all) signal(p, 'SIGTERM')
    const until = Date.now() + (opts.graceMs ?? 3000)
    while (Date.now() < until && all.some(alive)) await sleep(50)
    sample()
    signal(-leader, 'SIGKILL')
    for (const p of [leader, ...seen]) if (p > 0) signal(p, 'SIGKILL')
  }
  const timer = setTimeout(() => {
    kill.done = killTree()
  }, opts.deadlineMs)
  const { code, sig } = await new Promise<{ code: number | null; sig: string | null }>((res) => {
    child.on('error', (e) => {
      stderrTail += `\nspawn failed: ${e.message}`
      res({ code: 127, sig: null })
    })
    child.on('close', (c, s) => res({ code: c, sig: s }))
  })
  clearTimeout(timer)
  clearInterval(sampler)
  if (kill.done) await kill.done
  // Anything we watched start under this command and that outlived it (a worker, a daemonized helper) goes too.
  const left = [...seen].filter(alive)
  for (const p of left) signal(p, 'SIGKILL')
  return {
    code,
    signal: sig,
    ok: code === 0 && !kill.timedOut,
    timedOut: kill.timedOut,
    wallMs: Date.now() - started,
    stdout,
    stderrTail,
    reaped: left,
  }
}
