// Local mode end to end on the packed CLI with the fixture agent (beads va-p1th.5.15, 5.17): the phase 4 gate's CI job.
// Packs netlify-video-agent (with dist/runtime), installs the tarball into a temp prefix, then:
//   1. video-agent local "<prompt>" --agent fixture --json   → ./videos/<slug>/v1/video.mp4 (ffprobe), video.json
//   2. video-agent local revise <dir> "<change>" --agent fixture   → v2, with the runtime reused (no npm install)
//   3. video-agent local demo <recording> --quick   → a Quick demo, no agent and no model (runtime reused)
// The real runtime install, agent-kit with its redirected HOME, the render broker and the done.json handoff all run;
// only the agent is the fixture. No model, no network beyond the first runtime and agent-kit install. JSON lines out.
//   npx tsx scripts/local-fixture-e2e.ts [--keep]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const keep = process.argv.includes('--keep')
const started = Date.now()
const log = (step: string, f: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      s: Math.round((Date.now() - started) / 1000),
      step,
      ...f,
    }),
  )
const fail = (msg: string, f: Record<string, unknown> = {}): never => {
  log('FAIL', { msg, ...f })
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'va-local-e2e-'))
execFileSync('npx', ['tsx', 'scripts/build-packages.ts', 'cli'], { cwd: repo, stdio: 'inherit' })
const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
  cwd: join(repo, 'packages', 'cli'),
  encoding: 'utf8',
})
const [first] = JSON.parse(packed) as { filename: string }[]
if (!first) fail('npm pack wrote nothing')
const tarball = join(work, first?.filename ?? '')
log('packed', { tarball, bytes: readFileSync(tarball).length })
const prefix = join(work, 'prefix')
execFileSync('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', tarball], {
  stdio: 'inherit',
})
const bin = join(prefix, 'bin', 'video-agent')
const project = join(work, 'project')
execFileSync('mkdir', ['-p', project])
const env: NodeJS.ProcessEnv = {
  ...process.env,
  XDG_CACHE_HOME: join(work, 'cache'),
  XDG_CONFIG_HOME: join(work, 'config'),
  // The CLI's event log on stderr (local.render_blocked, local.render_done), shown when a step fails.
  VIDEO_AGENT_DEBUG: '1',
}
delete env.VIDEO_AGENT_KEY
delete env.VIDEO_AGENT_URL

const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
  const t = Date.now()
  const r = spawnSync(bin, [...args, '--json'], {
    cwd: project,
    env: { ...env, ...extra },
    encoding: 'utf8',
    timeout: 30 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  log('cli', { args: args.slice(0, 2), code: r.status, ms: Date.now() - t })
  if (r.status !== 0) {
    const agentLog = /Its log: (\S+agent\.log)/.exec(r.stdout)?.[1]
    fail(`video-agent ${args[0]} exited ${r.status}`, {
      stdout: r.stdout.slice(-2000),
      stderr: r.stderr.slice(-6000),
      ...(agentLog && existsSync(agentLog) ? { agentLog: readFileSync(agentLog, 'utf8').slice(-6000) } : {}),
    })
  }
  return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as {
    dir: string
    version: number
    video: string
  }
}
const probe = (mp4: string) =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], {
      encoding: 'utf8',
    }).trim(),
  )

const v1 = cli(['local', 'A 10-second fixture launch card', '--agent', 'fixture'])
if (!existsSync(v1.video) || !(probe(v1.video) > 1)) fail('v1 has no playable video.mp4', v1)
const meta = JSON.parse(readFileSync(join(v1.dir, '..', 'video.json'), 'utf8')) as { versions: unknown[] }
if (meta.versions.length !== 1) fail('video.json should list one version', meta)
log('v1', { dir: v1.dir, durationSec: probe(v1.video), files: readdirSync(v1.dir) })

// The runtime is installed now: the revision must not reach npm.
const v2 = cli(['local', 'revise', join(v1.dir, '..'), 'Make the title bigger', '--agent', 'fixture'], {
  npm_config_offline: 'true',
})
if (v2.version !== 2 || !existsSync(v2.video)) fail('revise made no v2', v2)
log('v2', { dir: v2.dir, durationSec: probe(v2.video) })

// A Quick demo from a screen recording (va-rsk5.5.4): no agent, no model, the runtime reused.
const demo = cli(
  ['local', 'demo', join(repo, 'test', 'fixtures', 'recording', 'privacy', 'secrets.mp4'), '--quick'],
  {
    npm_config_offline: 'true',
  },
)
if (!existsSync(demo.video) || !(probe(demo.video) > 3))
  fail('local demo --quick made no playable video', demo)
log('demo', { dir: demo.dir, durationSec: probe(demo.video) })
if (!keep) rmSync(work, { recursive: true, force: true })
log('PASS', { sec: Math.round((Date.now() - started) / 1000), ...(keep ? { work } : {}) })
