// Shared helpers for the S11 and S12 spike harnesses (docs/plans/2026-11-02-record-your-own-voiceover.md §9).
// Node built-ins plus ffmpeg/ffprobe/python3/ps only, so the harnesses run on a bare Agent Runner image.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** One JSON line per step on stderr; stdout is kept for the final summary block. */
export const log = (step: string, fields: Record<string, unknown> = {}) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), step, ...fields }))
}

export const round = (n: number, places = 3) => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
export function sha1File(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

export function which(cmd: string): string | null {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' })
  const out = r.stdout.trim()
  return r.status === 0 && out ? out : null
}

/** Bytes under a directory (0 when missing). Uses du when present so hard links and sparse files count like disk. */
export function duBytes(path: string): number {
  if (!existsSync(path)) return 0
  const r = spawnSync('du', ['-sk', path], { encoding: 'utf8' })
  const kb = Number(r.stdout.trim().split(/\s+/)[0])
  if (r.status === 0 && Number.isFinite(kb)) return kb * 1024
  let total = 0
  const walk = (p: string) => {
    const s = statSync(p)
    if (s.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e))
    else total += s.size
  }
  walk(path)
  return total
}

export interface Proc {
  pid: number
  ppid: number
  pgid: number
  rssKb: number
  comm: string
}

/** Every process on the machine (ps, or /proc on Linux without ps). */
export function listProcs(): Proc[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,comm='], { encoding: 'utf8' })
  if (r.status === 0) {
    return r.stdout
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 5)
      .map(([pid, ppid, pgid, rss, ...comm]) => ({
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        rssKb: Number(rss),
        comm: comm.join(' '),
      }))
  }
  if (!existsSync('/proc')) return []
  const out: Proc[] = []
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const comm = stat.slice(stat.indexOf('(') + 1, close)
      const f = stat.slice(close + 2).split(' ')
      out.push({ pid: Number(d), ppid: Number(f[1]), pgid: Number(f[2]), rssKb: Number(f[21]) * 4, comm })
    } catch {
      // The process exited while we read it.
    }
  }
  return out
}

function descendantsOf(root: number, procs: Proc[]): Proc[] {
  const kids = new Map<number, Proc[]>()
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  const out: Proc[] = []
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop()!
    for (const k of kids.get(pid) ?? []) {
      out.push(k)
      stack.push(k.pid)
    }
  }
  return out
}

// Runs the command, waits for it, and writes the children's rusage as JSON (Linux ru_maxrss is KiB, macOS bytes).
const RUSAGE_PY = `
import json, resource, subprocess, sys
try:
    p = subprocess.run(sys.argv[2:])
    code = p.returncode
except FileNotFoundError as e:
    sys.stderr.write(str(e) + "\\n")
    code = 127
r = resource.getrusage(resource.RUSAGE_CHILDREN)
with open(sys.argv[1], "w") as f:
    json.dump({"utime": r.ru_utime, "stime": r.ru_stime, "maxrss": r.ru_maxrss, "platform": sys.platform}, f)
sys.exit(code if code >= 0 else 128 - code)
`

export interface GroupResult {
  label: string
  code: number | null
  signal: string | null
  ok: boolean
  timedOut: boolean
  wallMs: number
  /** CPU seconds of every waited-for descendant (python rusage wrapper); null without python3. */
  cpuUserS: number | null
  cpuSysS: number | null
  /** Largest single descendant's max RSS (ru_maxrss of RUSAGE_CHILDREN). */
  maxRssMb: number | null
  /** Largest sum of RSS over the process tree, sampled every second with ps. */
  peakTreeRssMb: number
  /** Distinct descendant pids seen while it ran. */
  descendantsSeen: number
  /** Descendants that left the process group (setsid/detached spawns such as Chrome under puppeteer). */
  escapedGroup: string[]
  /** After a deadline kill: true when nothing we saw is still alive. Null when no kill was needed. */
  reaped: boolean | null
  /** Descendant processes still alive after the command ended (killed by the harness afterwards). */
  leftover: string[]
  stdout: string
  stderrTail: string
}

export interface GroupOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  deadlineMs: number
  /** Called with each chunk of stdout/stderr. */
  onOutput?: (chunk: string) => void
  /** Keep full stdout up to this many bytes (default 16 MiB). */
  maxStdout?: number
  graceMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The outer deadline: spawn detached (its own process group), and on timeout SIGTERM the whole group, then SIGKILL
 * after a grace period. Reports CPU, RSS, and whether every descendant we ever saw is gone afterwards.
 */
export async function runGroup(label: string, cmd: string, args: string[], opts: GroupOptions): Promise<GroupResult> {
  const python = which('python3')
  const dir = mkdtempSync(join(tmpdir(), 'va-rusage-'))
  const rusageFile = join(dir, 'rusage.json')
  const [bin, argv] = python ? [python, ['-c', RUSAGE_PY, rusageFile, cmd, ...args]] : [cmd, args]
  const started = Date.now()
  const child = spawn(bin, argv, {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pgid = child.pid ?? -1
  const max = opts.maxStdout ?? 16 * 1024 * 1024
  let stdout = ''
  let stderrTail = ''
  child.stdout.on('data', (b: Buffer) => {
    const s = b.toString('utf8')
    if (stdout.length < max) stdout += s
    opts.onOutput?.(s)
  })
  child.stderr.on('data', (b: Buffer) => {
    const s = b.toString('utf8')
    stderrTail = (stderrTail + s).slice(-8000)
    opts.onOutput?.(s)
  })
  const seen = new Map<number, Proc>()
  let peakTreeKb = 0
  const sample = () => {
    const procs = listProcs()
    const tree = descendantsOf(pgid, procs)
    const self = procs.find((p) => p.pid === pgid)
    let kb = self?.rssKb ?? 0
    for (const p of tree) {
      kb += p.rssKb
      // Zombies show as "(name)" (macOS) or "<defunct>" with pgid 0; keep the first live sighting.
      if (!seen.has(p.pid) && !p.comm.startsWith('(') && !p.comm.includes('<defunct>')) seen.set(p.pid, p)
    }
    peakTreeKb = Math.max(peakTreeKb, kb)
  }
  const sampler = setInterval(sample, 1000)
  const kill = { timedOut: false }
  const killGroup = async () => {
    kill.timedOut = true
    sample()
    try {
      process.kill(-pgid, 'SIGTERM')
    } catch {
      // Already gone.
    }
    await sleep(opts.graceMs ?? 5000)
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  const timer = setTimeout(() => void killGroup(), opts.deadlineMs)
  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>((res) => {
    child.on('error', (e) => {
      stderrTail += `\nspawn failed: ${e.message}`
      res({ code: 127, signal: null })
    })
    child.on('close', (c, s) => res({ code: c, signal: s }))
  })
  clearTimeout(timer)
  clearInterval(sampler)
  const wallMs = Date.now() - started
  await sleep(500)
  const stillAlive = [...seen.values()].filter((p) => alive(p.pid))
  const leftover = stillAlive.map((p) => `${p.pid}:${p.comm}`)
  // Only processes we watched start under this command: kill them by pid so the harness leaves nothing behind.
  for (const p of stillAlive) {
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {
      // Gone.
    }
  }
  interface Rusage {
    utime: number
    stime: number
    maxrss: number
    platform: string
  }
  let rusage: Rusage | null = null
  try {
    rusage = JSON.parse(readFileSync(rusageFile, 'utf8')) as Rusage
  } catch {
    // Killed before python wrote it, or no python.
  }
  rmSync(dir, { recursive: true, force: true })
  const maxRssMb = rusage
    ? round(rusage.platform === 'darwin' ? rusage.maxrss / 1048576 : rusage.maxrss / 1024, 1)
    : null
  return {
    label,
    code,
    signal,
    ok: code === 0 && !kill.timedOut,
    timedOut: kill.timedOut,
    wallMs,
    cpuUserS: rusage ? round(rusage.utime, 2) : null,
    cpuSysS: rusage ? round(rusage.stime, 2) : null,
    maxRssMb,
    peakTreeRssMb: round(peakTreeKb / 1024, 1),
    descendantsSeen: seen.size,
    escapedGroup: [...seen.values()].filter((p) => p.pgid !== pgid).map((p) => `${p.pid}:${p.comm}`),
    reaped: kill.timedOut ? stillAlive.length === 0 : null,
    leftover,
    stdout,
    stderrTail,
  }
}

/** The fields of a GroupResult worth putting in a summary (no output). */
export function metrics(r: GroupResult) {
  const rest: Partial<GroupResult> = { ...r }
  delete rest.stdout
  delete rest.stderrTail
  return { ...rest, ...(r.ok ? {} : { stderrTail: r.stderrTail.trim().split('\n').slice(-6).join('\n').slice(-1500) }) }
}

/** Synchronous ffmpeg/ffprobe call; throws with the stderr tail. */
export function tool(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): string {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 10 * 60_000,
    maxBuffer: 256 * 1024 * 1024,
  })
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${(r.stderr || r.error?.message || '').slice(-1500)}`)
  return `${r.stdout}${r.stderr}`
}

/** ffmpeg writes most results to stderr; return both streams. */
export function ffmpeg(args: string[], timeoutMs?: number): string {
  return tool('ffmpeg', ['-hide_banner', '-nostdin', ...args], timeoutMs ? { timeoutMs } : {})
}

export interface Wav {
  rate: number
  samples: Int16Array
}

/** Any audio file, decoded by ffmpeg to mono s16 at `rate` (optionally through an audio filter). */
export function decodeMono(path: string, rate: number, filter?: string, stream = 'a:0'): Wav {
  const dir = mkdtempSync(join(tmpdir(), 'va-pcm-'))
  try {
    const out = join(dir, 'out.pcm')
    ffmpeg([
      '-loglevel',
      'error',
      '-y',
      '-i',
      path,
      '-map',
      `0:${stream}`,
      ...(filter ? ['-af', filter] : []),
      '-ac',
      '1',
      '-ar',
      String(rate),
      '-f',
      's16le',
      out,
    ])
    const buf = readFileSync(out)
    const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
    return { rate, samples: Int16Array.from(samples) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function writeWav(path: string, wav: Wav) {
  const data = Buffer.from(wav.samples.buffer, wav.samples.byteOffset, wav.samples.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(wav.rate, 24)
  h.writeUInt32LE(wav.rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

/** RMS of 16-bit samples in [from, to), as a 0..1 fraction of full scale. */
export function rms(s: Int16Array, from: number, to: number): number {
  let e = 0
  const a = Math.max(0, from)
  const b = Math.min(s.length, to)
  for (let i = a; i < b; i++) e += (s[i]! / 32768) ** 2
  return b > a ? Math.sqrt(e / (b - a)) : 0
}

export const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120)

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo)
}

/** Integrated loudness and true peak of the first audio stream (ffmpeg ebur128 summary). */
export function loudness(path: string): { lufs: number; truePeakDb: number; lra: number } {
  const out = ffmpeg(['-i', path, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'])
  const summary = out.slice(out.lastIndexOf('Summary:'))
  const num = (re: RegExp) => Number(re.exec(summary)?.[1] ?? 'NaN')
  return {
    lufs: num(/I:\s+(-?[\d.]+|-inf) LUFS/),
    lra: num(/LRA:\s+(-?[\d.]+) LU/),
    truePeakDb: num(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/),
  }
}

export function probe(path: string): {
  format?: { duration?: string; size?: string }
  streams?: { codec_type?: string; codec_name?: string; duration?: string; sample_rate?: string; nb_frames?: string; width?: number; height?: number; bit_rate?: string; start_time?: string; r_frame_rate?: string }[]
} {
  return JSON.parse(
    tool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,duration,sample_rate,nb_frames,width,height,bit_rate,start_time,r_frame_rate', '-of', 'json', path]),
  ) as ReturnType<typeof probe>
}

export function parseFlags(argv: string[]): Record<string, string> {
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

/** Prints the one summary block the runner prompt copies, and saves it next to the outputs. */
export function printSummary(marker: string, file: string, summary: unknown) {
  const text = JSON.stringify(summary, null, 2)
  writeFileSync(file, `${text}\n`)
  console.log(`===${marker}===`)
  console.log(text)
  console.log(`===${marker}===`)
}
