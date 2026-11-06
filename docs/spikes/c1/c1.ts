// Spike C1 (docs/plans/2026-11-04-cli-and-sdk.md §11 phase 0; bead va-p1th.1.1): can local mode run this repo's run
// scripts from a bundled copy, with pinned tools, in a workspace outside the repo, without touching the user's home?
//   npx tsx docs/spikes/c1/c1.ts [--cache <dir>] [--offline]
// Steps (one JSON line each, with ms and outcome):
//   bundle     esbuild the run scripts to <cache>/runtime/bundle/*.mjs; run-tools' repoRoot reads VA_REPO_ROOT
//              (the prototype of 4.1's override)
//   runtime    npm install of exact hyperframes, tsx and netlify-agent-kit into <cache>/runtime (lockfile kept);
//              --offline reuses it with npm_config_offline=true and must fetch nothing
//   workspace  <cache>/runs/<id>: video/ template + the contract1 fixture, context/, AGENTS.md, one-line
//              scripts/<name>.ts shims, node_modules symlinks, a fake `netlify` (blobs from local folders)
//   agent-kit  netlify-agent-kit install --force with HOME=<cache>/agent-kit-home
//   prepare    a v1 run manifest (author, one library image) and prepare-run through the shim
//   render     render-job with --upload blobs into .va-uploads and a callback to a local receiver
//   compare    the MP4's sha256 against a reference render of the same fixture with the repo's own hyperframes
//   home       the real ~/.local/bin and ~/.cache/netlify-agent-kit unchanged
// Spends nothing; renders locally (Chrome, ffmpeg).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { build } from 'esbuild'
import { runManifestKey, serializeRunManifest, type RunManifest } from '../../../src/lib/run-manifest.js'

const repo = join(import.meta.dirname, '..', '..', '..')
const argv = process.argv.slice(2)
const cache = argv.includes('--cache') ? argv[argv.indexOf('--cache') + 1]! : join(tmpdir(), 'va-c1')
const offline = argv.includes('--offline')
const PINS = { hyperframes: '0.8.222', tsx: '4.23.15', 'netlify-agent-kit': '0.4.0', 'css-tree': '3.2.1' }
const SCRIPTS = [
  'prepare-run',
  'render-job',
  'checkpoint',
  'check-contract',
  'voice',
  'openverse',
  'narration',
]

const log = (step: string, f: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), node: process.version, step, ...f }))
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const du = (dir: string): number => {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    n += e.isDirectory() ? du(p) : statSync(p).size
  }
  return n
}
async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const t = Date.now()
  try {
    const r = await fn()
    log(name, { ok: true, ms: Date.now() - t, ...(r && typeof r === 'object' ? (r as object) : {}) })
    return r
  } catch (e) {
    log(name, {
      ok: false,
      ms: Date.now() - t,
      error: e instanceof Error ? e.message.slice(0, 2000) : String(e),
    })
    throw e
  }
}
/** A listing of a folder (names and mtimes), to prove a step left it alone. */
const snapshot = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .map((n) => `${n}:${statSync(join(dir, n), { throwIfNoEntry: false })?.mtimeMs ?? 'gone'}`)
        .join('|')
    : 'absent'

const realHome = homedir()
const homeDirs = [join(realHome, '.local/bin'), join(realHome, '.cache/netlify-agent-kit')]
const before = homeDirs.map(snapshot)

const runtime = join(cache, 'runtime')
const bundleDir = join(runtime, 'bundle')
const kitHome = join(cache, 'agent-kit-home')

await step('bundle', async () => {
  mkdirSync(bundleDir, { recursive: true })
  const r = await build({
    entryPoints: SCRIPTS.map((s) => join(repo, 'scripts', `${s}.ts`)),
    outdir: bundleDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // The pinned runtime provides these; everything else (src/lib, parse5, …) is inside the bundle.
    // css-tree reads its data files relative to itself, so it stays a package (found by this spike).
    external: ['hyperframes', 'esbuild', 'css-tree'],
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'error',
    metafile: true,
    plugins: [
      {
        name: 'repo-root',
        setup(b) {
          b.onLoad({ filter: /scripts[\\/]lib[\\/]run-tools\.ts$/ }, (a) => ({
            loader: 'ts',
            contents: readFileSync(a.path, 'utf8').replace(
              "export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')",
              "export const repoRoot = process.env.VA_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')",
            ),
          }))
        },
      },
    ],
  })
  const bytes = Object.values(r.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
  return { scripts: SCRIPTS.length, bytes }
})

await step('runtime', () => {
  mkdirSync(runtime, { recursive: true })
  writeFileSync(
    join(runtime, 'package.json'),
    `${JSON.stringify({ name: 'va-runtime', private: true, type: 'module', dependencies: PINS }, null, 2)}\n`,
  )
  const env = {
    ...process.env,
    // Never the person's ~/.npmrc (credentials, registries).
    npm_config_userconfig: join(cache, 'empty-npmrc'),
    npm_config_cache: join(cache, 'npm-cache'),
    ...(offline ? { npm_config_offline: 'true' } : {}),
  }
  writeFileSync(env.npm_config_userconfig, '')
  const hasLock = existsSync(join(runtime, 'package-lock.json'))
  const t = Date.now()
  execFileSync('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: runtime,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  return {
    mode: hasLock ? 'ci' : 'install',
    offline,
    installMs: Date.now() - t,
    bytes: du(join(runtime, 'node_modules')),
  }
})

const id = `loc_${randomUUID().slice(0, 8)}`
const ws = join(cache, 'runs', id)
await step('workspace', () => {
  mkdirSync(join(ws, 'scripts'), { recursive: true })
  cpSync(join(repo, 'video'), join(ws, 'video'), {
    recursive: true,
    filter: (src) => !/node_modules|\.hyperframes/.test(relative(repo, src)),
  })
  for (const f of ['index.html', 'summary.json'])
    copyFileSync(join(repo, 'test/fixtures/contract1', f), join(ws, 'video', f))
  // The fixture's own media (its names are shorter than library ids, so they're written as an agent would).
  mkdirSync(join(ws, 'video/assets/media'), { recursive: true })
  copyFileSync(join(repo, 'test/fixtures/a169.mp4'), join(ws, 'video/assets/media/med_clip.mp4'))
  writeFileSync(
    join(ws, 'video/assets/media/med_logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#14b8a6"/></svg>\n',
  )
  cpSync(join(repo, 'context'), join(ws, 'context'), { recursive: true })
  copyFileSync(join(repo, 'AGENTS.md'), join(ws, 'AGENTS.md'))
  for (const s of SCRIPTS)
    writeFileSync(join(ws, 'scripts', `${s}.ts`), `import '${join(bundleDir, `${s}.mjs`)}'\n`)
  symlinkSync(join(runtime, 'node_modules'), join(ws, 'node_modules'))
  symlinkSync(join(runtime, 'node_modules'), join(ws, 'video', 'node_modules'))
  // agent-kit reads its config from the workspace's package.json, as on the runner.
  const rootPkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { netlifyAgent: unknown }
  writeFileSync(
    join(ws, 'package.json'),
    `${JSON.stringify({ name: 'va-local-run', private: true, type: 'module', netlifyAgent: rootPkg.netlifyAgent }, null, 2)}\n`,
  )
  mkdirSync(join(ws, '.bin'))
  copyFileSync(join(import.meta.dirname, 'netlify-shim.mjs'), join(ws, '.bin', 'netlify'))
  execFileSync('chmod', ['+x', join(ws, '.bin', 'netlify')])
  return { ws }
})

const PATH = [
  join(ws, '.bin'),
  join(runtime, 'node_modules/.bin'),
  join(kitHome, '.local/bin'),
  process.env.PATH,
].join(':')
const childEnv = {
  ...process.env,
  PATH,
  HOME: kitHome,
  VA_REPO_ROOT: ws,
  npm_config_userconfig: join(cache, 'empty-npmrc'),
  npm_config_cache: join(cache, 'npm-cache'),
  ...(offline ? { npm_config_offline: 'true' } : {}),
}
const run = (cmd: string, args: string[], cwd = ws) => {
  const r = spawnSync(cmd, args, { cwd, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout).slice(-1500)}`)
  return r
}

await step('agent-kit', () => {
  mkdirSync(kitHome, { recursive: true })
  run(join(runtime, 'node_modules/.bin/netlify-agent-kit'), ['install', '--force'])
  const skills = existsSync(join(ws, '.claude/skills')) ? readdirSync(join(ws, '.claude/skills')) : []
  const agents = existsSync(join(ws, '.agents/skills')) ? readdirSync(join(ws, '.agents/skills')) : []
  const tools = Object.fromEntries(
    ['ffmpeg', 'ffprobe', 'hyperframes', 'tsx', 'netlify'].map((t) => [
      t,
      spawnSync('sh', ['-c', `command -v ${t}`], { env: childEnv, encoding: 'utf8' }).stdout.trim(),
    ]),
  )
  return { skills, agentsSkills: agents.length, kitHomeBytes: du(kitHome), tools }
})

await step('prepare', () => {
  const job = 'loc_job'
  const attempt = id
  const image = readFileSync(join(repo, 'test/fixtures/poster.jpg'))
  const imageKey = 'med_c1fixture01/original.jpg'
  mkdirSync(join(ws, '.va-inputs/media', 'med_c1fixture01'), { recursive: true })
  writeFileSync(join(ws, '.va-inputs/media', imageKey), image)
  const m: RunManifest = {
    v: 1,
    jobId: job,
    attemptId: attempt,
    versionN: 1,
    kind: 'author',
    source: null,
    bundle: null,
    media: [
      {
        key: imageKey,
        sha256: createHash('sha256').update(image).digest('hex'),
        filename: 'med_c1fixture01.jpg',
        kind: 'image',
      },
    ],
    feedback: null,
  }
  const text = serializeRunManifest(m)
  const key = runManifestKey(job, attempt)
  mkdirSync(join(ws, '.va-inputs/sources', job, 'runs'), { recursive: true })
  writeFileSync(join(ws, '.va-inputs/sources', key), text)
  const hash = createHash('sha256').update(text).digest('hex')
  // Restore the fixture after prepare (author runs scaffold nothing for HyperFrames; the agent would write it).
  run('npx', ['tsx', 'scripts/prepare-run.ts', '--job', job, '--attempt', attempt, '--manifest', hash])
  return {
    media: existsSync(join(ws, 'video/assets/media/med_c1fixture01.jpg')),
    runManifest: existsSync(join(ws, '.render/run-manifest.json')),
  }
})

const received: { headers: Record<string, string>; body: string }[] = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c: Buffer) => (body += c.toString()))
  req.on('end', () => {
    received.push({ headers: req.headers as Record<string, string>, body })
    res.writeHead(202, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port

/** Like run, but async, so the callback receiver in this process can answer while it runs. */
const runAsync = (cmd: string, args: string[]) =>
  new Promise<{ stderr: string }>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ws, env: childEnv })
    let stderr = ''
    p.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    p.stdout.resume()
    p.on('close', (code) =>
      code === 0 ? resolve({ stderr }) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1500)}`)),
    )
  })

const rendered = await step('render', async () => {
  const r = await runAsync('npx', [
    'tsx',
    'scripts/render-job.ts',
    '--job',
    'loc_job',
    '--attempt',
    id,
    '--callback',
    `http://127.0.0.1:${port}/api/internal/runs/${id}/done`,
    '--token',
    'local-token',
    '--upload',
    'blobs',
  ])
  const mp4 = join(ws, '.va-uploads/uploads', id, 'video.mp4')
  const done = received.find((x) => x.headers['content-type']?.includes('json') && x.body.includes('"files"'))
  return {
    mp4: existsSync(mp4),
    sha256: existsSync(mp4) ? sha(mp4) : null,
    bytes: existsSync(mp4) ? statSync(mp4).size : 0,
    uploads: existsSync(join(ws, '.va-uploads/uploads', id))
      ? readdirSync(join(ws, '.va-uploads/uploads', id)).sort()
      : [],
    callbacks: received.length,
    doneCallback: Boolean(done),
    stderrTail: r.stderr.split('\n').filter(Boolean).slice(-3),
  }
})
server.close()

const mp4Sha = rendered.sha256
await step('compare', () => {
  // The same fixture rendered with the repo's own hyperframes, in a scratch copy (never the repo's video/).
  const ref = join(cache, 'reference', id)
  cpSync(join(ws, 'video'), ref, {
    recursive: true,
    dereference: false,
    filter: (s) => !s.includes('node_modules'),
  })
  symlinkSync(join(repo, 'node_modules'), join(ref, 'node_modules'))
  const out = join(ref, 'out.mp4')
  const q = process.env.RENDER_QUALITY ?? 'standard'
  const r = spawnSync(
    join(repo, 'node_modules/.bin/hyperframes'),
    ['render', '--quality', q, '--output', out],
    {
      cwd: ref,
      env: { ...childEnv, VA_REPO_ROOT: '' },
      encoding: 'utf8',
    },
  )
  const refSha = existsSync(out) ? sha(out) : null
  return {
    referenceExit: r.status,
    referenceSha256: refSha,
    sameAsLocalMode: refSha !== null && refSha === mp4Sha,
  }
})

await step('home', () => {
  const after = homeDirs.map(snapshot)
  const same = after.every((a, i) => a === before[i])
  if (!same) throw new Error(`the real home changed: ${JSON.stringify({ before, after })}`)
  return { untouched: homeDirs }
})

writeFileSync(
  join(cache, `result-${offline ? 'offline' : 'online'}-${process.version}.json`),
  JSON.stringify(rendered),
)
log('done', { ws, sha256: rendered.sha256 })
