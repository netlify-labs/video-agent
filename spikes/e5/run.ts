// Spike E5 (render-engines plan §11, bead va-ed2s.1.5): determinism, offline fonts and clips, the config files
// Remotion's toolchain reads from the project, and whether REMOTION_ env vars reach composition code. Local evaluation
// only (owner's go-ahead 2026-11-05): development renders with licenseKey "free-license"; nothing is published.
//
//   cd spikes/e3 && npm ci && cd ../e5 && ln -sfn ../e3/node_modules node_modules && npx tsx run.ts
//
// One JSON line per check: { check, ok, ms, ... }. Writes results.json. The offline checks run in a child process
// under macOS sandbox-exec with all outbound network denied except loopback (the renderer's own local server).
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const work = join(here, '.work')
const LICENSE = { licenseKey: 'free-license', isProduction: false } as const
const log = (check: string, f: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), check, ...f }))
}
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const results: Record<string, unknown>[] = []
const record = (check: string, f: Record<string, unknown>) => {
  results.push({ check, ...f })
  log(check, f)
}

/** Every file under a directory, as paths relative to it. */
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))],
  )
}

function setupProject(to: string) {
  rmSync(to, { recursive: true, force: true })
  cpSync(join(here, 'project'), to, { recursive: true })
  mkdirSync(join(to, 'assets', 'media'), { recursive: true })
  mkdirSync(join(to, 'assets', 'fonts'), { recursive: true })
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '4', '-pix_fmt', 'yuv420p', join(to, 'assets', 'media', 'clip.mp4')])
  cpSync('/System/Library/Fonts/Supplemental/Courier New.ttf', join(to, 'assets', 'fonts', 'spike.ttf'))
}

// ───── the offline child: renders under sandbox-exec, reports what loaded ─────
if (process.argv[2] === '--offline') {
  const serveUrl = process.argv[3] ?? ''
  const { openBrowser, renderStill, selectComposition } = await import('@remotion/renderer')
  const out: Record<string, unknown> = {}
  const browser = await openBrowser('chrome', { logLevel: 'error' })
  for (const [id, frame] of [
    ['local-font', 0],
    ['motion', 45],
    ['remote-font', 0],
  ] as const) {
    const logs: string[] = []
    const t = Date.now()
    try {
      const comp = await selectComposition({ serveUrl, id, puppeteerInstance: browser, timeoutInMilliseconds: 10_000, ...LICENSE, onBrowserLog: (l) => logs.push(l.text) })
      const file = join(work, `offline-${id}.png`)
      await renderStill({ composition: comp, serveUrl, frame, output: file, puppeteerInstance: browser, timeoutInMilliseconds: 10_000, ...LICENSE, onBrowserLog: (l) => logs.push(l.text) })
      out[id] = { ok: true, ms: Date.now() - t, sha256: sha(readFileSync(file)), logs: logs.filter((l) => l.startsWith('e5:')) }
    } catch (e) {
      out[id] = { ok: false, ms: Date.now() - t, error: String(e).split('\n')[0]?.slice(0, 300) }
    }
  }
  await browser.close({ silent: true })
  console.log(`E5_OFFLINE ${JSON.stringify(out)}`)
  process.exit(0)
}

mkdirSync(work, { recursive: true })

// ───── 4 + 5: what bundle() reads from the project, and which env reaches the composition ─────
const marker = (name: string) => join(work, `read-${name}`)
const markJs = (name: string, exportsJs: string) =>
  `require('fs').writeFileSync(${JSON.stringify(marker(name))}, '1'); module.exports = ${exportsJs}\n`
/** Each candidate either leaves a marker when it's loaded, or would break the bundle if it were read. */
const CANDIDATES: Record<string, string> = {
  'babel.config.js': markJs('babel.config.js', '{}'),
  '.babelrc': '{ not json',
  'postcss.config.js': markJs('postcss.config.js', '{ plugins: [] }'),
  'webpack.config.js': markJs('webpack.config.js', '{}'),
  '.browserslistrc': 'this is not a browserslist query\n',
  browserslist: 'this is not a browserslist query either\n',
  'package.json': JSON.stringify({ name: 'e5', private: true, browserslist: ['not a real query'] }),
  'tsconfig.json': '{ not json',
  'remotion.config.ts': `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(marker('remotion.config.ts'))}, '1')\n`,
  '.env': 'REMOTION_DOTENV=from-dotenv-file\n',
  '.env.local': 'REMOTION_DOTENV=from-dotenv-local\n',
}

// Every path the bundler opens, through the fs module webpack and its loaders use.
let watching = ''
const opened = new Set<string>()
for (const name of ['readFile', 'readFileSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'existsSync'] as const) {
  const orig = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
  if (!orig) continue
  ;(fs as unknown as Record<string, unknown>)[name] = function (this: unknown, p: unknown, ...rest: unknown[]) {
    if (watching && typeof p === 'string' && p.startsWith(watching)) opened.add(relative(watching, p))
    return orig.call(this, p, ...rest)
  }
}
const { bundle } = await import('@remotion/bundler')
const { openBrowser, renderMedia, renderStill, selectComposition } = await import('@remotion/renderer')
const jsOf = (dir: string) =>
  walk(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')

{
  const reads: Record<string, unknown> = {}
  for (const [file, body] of Object.entries(CANDIDATES)) {
    const dir = join(work, `cfg-${file.replace(/[^a-z]/gi, '')}`)
    setupProject(dir)
    writeFileSync(join(dir, file), body)
    rmSync(marker(file), { force: true })
    opened.clear()
    watching = dir
    let error: string | null = null
    let js = ''
    try {
      js = jsOf(await bundle({ entryPoint: join(dir, 'src', 'index.ts'), publicDir: join(dir, 'assets'), outDir: join(dir, '.bundle') }))
    } catch (e) {
      error = String(e).split('\n')[0]?.slice(0, 200) ?? 'error'
    }
    watching = ''
    reads[file] = {
      opened: opened.has(file),
      loaded: existsSync(marker(file)),
      bundleFailed: error,
      ...(file.startsWith('.env') ? { inlined: js.includes('from-dotenv') } : {}),
    }
  }
  record('config_files_node_api', { ok: true, reads })
}
{
  const dir = join(work, 'cfg-env')
  setupProject(dir)
  const SECRET = 'e5-secret-from-process-env'
  process.env.REMOTION_TEST = SECRET
  process.env.VIDEO_AGENT_REMOTION_KEY = 'rm_sec_e5-not-inlined'
  const out = await bundle({ entryPoint: join(dir, 'src', 'index.ts'), publicDir: join(dir, 'assets'), outDir: join(dir, '.bundle') })
  const js = jsOf(out)
  delete process.env.REMOTION_TEST
  delete process.env.VIDEO_AGENT_REMOTION_KEY
  // What the composition itself sees at render time, without and with renderStill's envVariables.
  const browser = await openBrowser('chrome', { logLevel: 'error' })
  const comp = await selectComposition({ serveUrl: out, id: 'env', puppeteerInstance: browser, ...LICENSE })
  const seen = async (extra: object) => {
    const logs: string[] = []
    await renderStill({ composition: comp, serveUrl: out, frame: 0, output: join(work, 'env.png'), puppeteerInstance: browser, ...extra, ...LICENSE, onBrowserLog: (l) => logs.push(l.text) })
    return logs.find((l) => l.startsWith('e5:env')) ?? null
  }
  const plain = await seen({})
  const withVars = await seen({ envVariables: { REMOTION_TEST: 'passed-as-envVariables' } })
  await browser.close({ silent: true })
  record('env_node_api', {
    ok: true,
    inlinedInBundle: { REMOTION_TEST: js.includes(SECRET), VIDEO_AGENT_REMOTION_KEY: js.includes('rm_sec_e5') },
    composition: plain,
    compositionWithEnvVariables: withVars,
  })
}
{
  // The CLI's own bundle: it reads remotion.config.ts and .env files, and inlines REMOTION_* from the shell.
  const dir = join(work, 'cfg-cli')
  setupProject(dir)
  writeFileSync(join(dir, '.env'), CANDIDATES['.env'] ?? '')
  writeFileSync(join(dir, 'remotion.config.ts'), CANDIDATES['remotion.config.ts'] ?? '')
  rmSync(marker('remotion.config.ts'), { force: true })
  const t = Date.now()
  const outDir = join(dir, '.bundle')
  const r = spawnSync(join(here, 'node_modules', '.bin', 'remotion'), ['bundle', 'src/index.ts', '--out-dir', outDir, '--public-dir', 'assets'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, REMOTION_TEST: 'e5-secret-from-cli-shell', VIDEO_AGENT_REMOTION_KEY: 'rm_sec_e5-cli' },
    timeout: 300_000,
  })
  const js = existsSync(outDir) ? jsOf(outDir) : ''
  record('env_cli', {
    ok: r.status === 0,
    ms: Date.now() - t,
    remotionConfigLoaded: existsSync(marker('remotion.config.ts')),
    inlined: { REMOTION_TEST: js.includes('e5-secret-from-cli-shell'), dotenv: js.includes('from-dotenv-file'), VIDEO_AGENT_REMOTION_KEY: js.includes('rm_sec_e5') },
    tail: r.status === 0 ? null : (r.stderr || r.stdout).trim().split('\n').slice(-3),
  })
}
{
  // A valid but old target changes what webpack emits when it reads it: compare the bundle's JS with and without.
  // One path for every build: separate folders give different bundles even with the same sources.
  const hashOf = async (_name: string, files: Record<string, string>) => {
    const dir = join(work, 'bl')
    setupProject(dir)
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body)
    const out = await bundle({ entryPoint: join(dir, 'src', 'index.ts'), publicDir: join(dir, 'assets'), outDir: join(dir, '.bundle') })
    return sha(jsOf(out))
  }
  const none = await hashOf('none', {})
  const again = await hashOf('again', {})
  const file = await hashOf('file', { '.browserslistrc': 'IE 11\n' })
  const pkg = await hashOf('pkg', { 'package.json': JSON.stringify({ name: 'e5', private: true, browserslist: ['IE 11'] }) })
  record('browserslist_changes_output', {
    ok: true,
    stableWithout: none === again,
    browserslistrc: file !== none,
    packageJsonField: pkg !== none,
  })
}
{
  // The CLI's render path: what a composition sees from the shell env and .env, and whether remotion.config.ts runs.
  const dir = join(work, 'cli-still')
  setupProject(dir)
  // A package.json makes this folder the Remotion root, as video/ is in a run (else the CLI looks further up).
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'e5-cli', private: true }))
  // The CLI stops without one ("Could not find a tsconfig.json file in your project").
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true, module: 'ESNext', moduleResolution: 'bundler', skipLibCheck: true } }))
  writeFileSync(join(dir, '.env'), 'REMOTION_DOTENV=from-dotenv-file\n')
  writeFileSync(join(dir, 'remotion.config.ts'), CANDIDATES['remotion.config.ts'] ?? '')
  rmSync(marker('remotion.config.ts'), { force: true })
  const r = spawnSync(join(here, 'node_modules', '.bin', 'remotion'), ['still', 'src/index.ts', 'env-throw', join(work, 'cli-env.png'), '--public-dir', 'assets', '--log', 'verbose'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, REMOTION_TEST: 'e5-secret-from-cli-shell', VIDEO_AGENT_REMOTION_KEY: 'rm_sec_e5-cli' },
    timeout: 300_000,
  })
  const all = `${r.stdout}\n${r.stderr}`
  record('cli_still', {
    // The composition throws on purpose: the render fails, and the error carries what it saw.
    ok: /e5:env \{/.test(all),
    composition: /e5:env (\{[^\n]*\})/.exec(all)?.[1] ?? null,
    remotionConfigLoaded: existsSync(marker('remotion.config.ts')),
    // At 4.0.540 the CLI refuses --license-key free-license ("must start with rm_sec_"); without a key it warns.
    licenseWarning: /licenseKey|license key|free-license/i.test(all),
  })
}

// ───── 1: determinism ─────
const clean = join(work, 'clean')
setupProject(clean)
const serveUrl = await bundle({ entryPoint: join(clean, 'src', 'index.ts'), publicDir: join(clean, 'assets'), outDir: join(work, 'clean-bundle') })
const FRAMES = [0, 30, 45, 89]
const stills = async (browser: Awaited<ReturnType<typeof openBrowser>>) => {
  const comp = await selectComposition({ serveUrl, id: 'motion', puppeteerInstance: browser, ...LICENSE })
  const out: string[] = []
  for (const frame of FRAMES) {
    const file = join(work, `motion-${frame}.png`)
    await renderStill({ composition: comp, serveUrl, frame, output: file, puppeteerInstance: browser, ...LICENSE })
    out.push(sha(readFileSync(file)))
  }
  return { comp, out }
}
{
  const b1 = await openBrowser('chrome', { logLevel: 'error' })
  const first = await stills(b1)
  const second = await stills(b1)
  const mp4 = async (name: string) => {
    const file = join(work, name)
    const t = Date.now()
    await renderMedia({ composition: first.comp, serveUrl, codec: 'h264', outputLocation: file, frameRange: [0, 59], puppeteerInstance: b1, ...LICENSE })
    return { sha256: sha(readFileSync(file)), bytes: statSync(file).size, ms: Date.now() - t }
  }
  const m1 = await mp4('motion-1.mp4')
  const m2 = await mp4('motion-2.mp4')
  await b1.close({ silent: true })
  const b2 = await openBrowser('chrome', { logLevel: 'error' })
  const third = await stills(b2)
  await b2.close({ silent: true })
  // Decoded frames of both MP4s, in case the container bytes differ but the pictures don't.
  const frames = (f: string) => sha(execFileSync('ffmpeg', ['-loglevel', 'error', '-i', join(work, f), '-f', 'framemd5', '-'], { encoding: 'utf8' }).replace(/^#.*\n/gm, ''))
  record('determinism', {
    ok: first.out.join() === second.out.join() && first.out.join() === third.out.join() && frames('motion-1.mp4') === frames('motion-2.mp4'),
    stillsSameBrowser: first.out.join() === second.out.join(),
    stillsNewBrowser: first.out.join() === third.out.join(),
    mp4Bytes: m1.sha256 === m2.sha256,
    mp4Frames: frames('motion-1.mp4') === frames('motion-2.mp4'),
    mp4: [m1, m2],
    stills: Object.fromEntries(FRAMES.map((f, i) => [f, first.out[i]?.slice(0, 12)])),
  })
  writeFileSync(join(work, 'online-motion-45.sha256'), first.out[2] ?? '')
}

// ───── 2 + 3: offline: a local font and a library clip render; a remote font doesn't ─────
{
  const profile = join(work, 'offline.sb')
  writeFileSync(profile, '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))\n')
  const probe = spawnSync('sandbox-exec', ['-f', profile, 'curl', '-sS', '-m', '5', 'https://fonts.googleapis.com', '-o', '/dev/null'], { encoding: 'utf8' })
  const t = Date.now()
  const r = spawnSync('sandbox-exec', ['-f', profile, process.execPath, '--import', 'tsx', fileURLToPath(import.meta.url), '--offline', serveUrl], { cwd: here, encoding: 'utf8', timeout: 300_000 })
  const line = r.stdout.split('\n').find((l) => l.startsWith('E5_OFFLINE ')) ?? ''
  const got = line ? (JSON.parse(line.slice('E5_OFFLINE '.length)) as Record<string, { ok: boolean; sha256?: string; logs?: string[]; error?: string }>) : {}
  const online45 = readFileSync(join(work, 'online-motion-45.sha256'), 'utf8')
  record('offline', {
    ok: got['local-font']?.ok === true && (got['local-font'].logs ?? []).includes('e5:font loaded') && got.motion?.sha256 === online45 && got['remote-font']?.ok === false,
    ms: Date.now() - t,
    networkBlocked: probe.status !== 0,
    localFont: got['local-font'] ?? null,
    clipFrameMatchesOnline: got.motion?.sha256 === online45,
    remoteFont: got['remote-font'] ?? null,
    stderr: r.status === 0 ? null : r.stderr.trim().split('\n').slice(-5),
  })
}

const failed = results.filter((r) => r.ok === false).map((r) => r.check)
writeFileSync(join(here, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
log(failed.length ? 'E5_FAIL' : 'E5_OK', { failed })
process.exit(failed.length ? 1 : 0)
