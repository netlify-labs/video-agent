// The Remotion proof run (owner's request, 2026-11-05; render-engines plan §11 POC, E1 + a one-video E2): the steps an
// Agent Runner run takes to make ONE Remotion video. Development renders only: licenseKey "free-license" and
// isProduction false, no envVariables (E5: nothing else reaches composition code through the Node API).
//
//   npx tsx spikes/e3/poc.ts setup             install (npm ci --ignore-scripts), Chrome Headless Shell, ldd, poc/ from poc-template/
//   npx tsx spikes/e3/poc.ts check             registry from props.json, schema, scan, bundle, stills at each beat
//   npx tsx spikes/e3/poc.ts render [--upload] the MP4, probed and hashed; --upload puts it in the spike-remotion store
//   npx tsx spikes/e3/poc.ts rehearse          setup + a sample video (E3's) + check + render, locally, no upload
//
// Every command prints one JSON line as its last line. Timings, sizes and the render tally are kept in
// spikes/e3/poc/report.json across commands, so the final answer can carry them all.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Remotion caches Chrome Headless Shell under the nearest package.json to the working directory: keep it in ours.
process.chdir(here)
const poc = join(here, 'poc')
const reportFile = join(poc, 'report.json')
const LICENSE = { licenseKey: 'free-license', isProduction: false } as const
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
type Report = { steps: Record<string, unknown>[]; renders: { video: number; stills: number } }
const report = (): Report =>
  existsSync(reportFile) ? (JSON.parse(readFileSync(reportFile, 'utf8')) as Report) : { steps: [], renders: { video: 0, stills: 0 } }
const save = (r: Report) => {
  mkdirSync(poc, { recursive: true })
  writeFileSync(reportFile, JSON.stringify(r, null, 2))
}
const step = (name: string, f: Record<string, unknown>) => {
  const r = report()
  r.steps.push({ name, ...f })
  save(r)
  console.log(JSON.stringify({ step: name, ...f }))
}
const timed = <T>(fn: () => T): [T, number] => {
  const t = Date.now()
  return [fn(), Date.now() - t]
}
const du = (p: string) => Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split('\t')[0]) * 1024

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
}

async function setup() {
  const [, installMs] = timed(() =>
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: here, stdio: 'ignore', timeout: 600_000 }),
  )
  step('install', { ms: installMs, bytes: du(join(here, 'node_modules')) })
  const { ensureBrowser } = await import('@remotion/renderer')
  const t = Date.now()
  await ensureBrowser({ logLevel: 'error' })
  const shell = walk(join(here, 'node_modules', '.remotion')).find((f) => /chrome-headless-shell$/.test(f)) ?? null
  // Linux only: the shared libraries Chrome Headless Shell needs that the image doesn't have (spec §2's list).
  const missing =
    shell && process.platform === 'linux'
      ? execFileSync('ldd', [shell], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('not found')).map((l) => l.trim())
      : []
  step('browser', {
    ms: Date.now() - t,
    bytes: existsSync(join(here, 'node_modules', '.remotion')) ? du(join(here, 'node_modules', '.remotion')) : 0,
    binarySha256: shell ? sha(readFileSync(shell)) : null,
    missingLibraries: missing,
    platform: `${process.platform}-${process.arch}`,
  })
  rmSync(poc, { recursive: true, force: true })
  cpSync(join(here, 'poc-template'), poc, { recursive: true })
  for (const d of ['src/beats', 'src/layers', 'assets/media', 'assets/fonts', 'stills']) mkdirSync(join(poc, d), { recursive: true })
  save({ steps: report().steps, renders: { video: 0, stills: 0 } })
  step('template', { files: walk(poc).map((f) => relative(poc, f)).filter((f) => f !== 'report.json') })
}

async function bundled() {
  const { registryFor } = await import('./contract-props.js')
  const { vaSchema } = await import('./project/src/va/schema.js')
  const props = vaSchema.parse(JSON.parse(readFileSync(join(poc, 'props.json'), 'utf8')))
  writeFileSync(join(poc, 'src', 'registry.ts'), registryFor(props))
  // The static scan's v1 rules (spec §5.2 check 3): nothing from a URL, no env, no Google Fonts.
  const problems: string[] = []
  for (const b of props.beats)
    if (!existsSync(join(poc, 'src', 'beats', `${b.id}.tsx`))) problems.push(`src/beats/${b.id}.tsx is missing.`)
  for (const l of props.layers)
    if (!existsSync(join(poc, 'src', 'layers', `${l.id}.tsx`))) problems.push(`src/layers/${l.id}.tsx is missing.`)
  for (const f of walk(join(poc, 'src')).filter((x) => x.endsWith('.tsx') || x.endsWith('.ts'))) {
    const text = readFileSync(f, 'utf8')
    if (/https?:\/\//.test(text)) problems.push(`${relative(poc, f)} uses a URL.`)
    if (/process\.env/.test(text)) problems.push(`${relative(poc, f)} reads process.env.`)
    if (/@remotion\/google-fonts/.test(text)) problems.push(`${relative(poc, f)} imports Google Fonts.`)
  }
  if (problems.length) throw new Error(`check failed:\n- ${problems.join('\n- ')}`)
  const { bundle } = await import('@remotion/bundler')
  const t = Date.now()
  const serveUrl = await bundle({ entryPoint: join(poc, 'src', 'index.ts'), publicDir: join(poc, 'assets') })
  return { props, serveUrl, bundleMs: Date.now() - t }
}

async function check() {
  const { props, serveUrl, bundleMs } = await bundled()
  const { openBrowser, renderStill, selectComposition } = await import('@remotion/renderer')
  const { layout } = await import('./project/src/va/layout.js')
  const browser = await openBrowser('chrome', { logLevel: 'error' })
  const t = Date.now()
  const comp = await selectComposition({ serveUrl, id: 'main', puppeteerInstance: browser, ...LICENSE })
  const lay = layout(props.beats)
  const stills: string[] = []
  for (const [i, b] of props.beats.entries()) {
    const at = lay.beats[i]
    if (!at) continue
    const file = join(poc, 'stills', `${String(i + 1).padStart(2, '0')}-${b.id}.png`)
    await renderStill({ composition: comp, serveUrl, frame: at.startFrame + Math.floor(at.frames / 2), output: file, puppeteerInstance: browser, ...LICENSE })
    stills.push(relative(join(here, '..', '..'), file))
  }
  await browser.close({ silent: true })
  const r = report()
  r.renders.stills += stills.length
  save(r)
  step('check', { ok: true, bundleMs, stillsMs: Date.now() - t, durationInFrames: comp.durationInFrames, stills })
}

async function render(upload: boolean) {
  const { serveUrl, bundleMs } = await bundled()
  const { renderMedia, selectComposition } = await import('@remotion/renderer')
  const out = join(poc, 'remotion.mp4')
  const comp = await selectComposition({ serveUrl, id: 'main', ...LICENSE })
  const t = Date.now()
  await renderMedia({ composition: comp, serveUrl, codec: 'h264', outputLocation: out, muted: true, ...LICENSE })
  const renderMs = Date.now() - t
  const r = report()
  r.renders.video += 1
  save(r)
  const bytes = readFileSync(out)
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', out], { encoding: 'utf8' })
  let uploaded: string | null = null
  if (upload) {
    const cli = ['netlify', '/opt/buildhome/node-deps/node_modules/.bin/netlify'].find(
      (c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0,
    )
    if (cli) {
      const key = `poc/${new Date().toISOString().slice(0, 10)}-${sha(bytes).slice(0, 12)}.mp4`
      const u = spawnSync(cli, ['blobs:set', 'spike-remotion', key, '--input', out], { stdio: 'ignore', timeout: 300_000 })
      if (u.status === 0) uploaded = key
    }
  }
  step('render', {
    ok: true,
    bundleMs,
    renderMs,
    bytes: bytes.byteLength,
    sha256: sha(bytes),
    probe: probe.status === 0 ? (JSON.parse(probe.stdout) as unknown) : null,
    uploaded,
    renders: report().renders,
  })
}

/** Locally, with no credits: setup, E3's video as the sample, check, render. Proves the scripts before a run. */
async function rehearse() {
  await setup()
  cpSync(join(here, 'project', 'props.json'), join(poc, 'props.json'))
  cpSync(join(here, 'project', 'summary.json'), join(poc, 'summary.json'))
  for (const d of ['beats', 'layers']) cpSync(join(here, 'project', 'src', d), join(poc, 'src', d), { recursive: true })
  cpSync(join(here, 'project', 'assets'), join(poc, 'assets'), { recursive: true })
  await check()
  await render(false)
}

const cmd = process.argv[2]
try {
  if (cmd === 'setup') await setup()
  else if (cmd === 'check') await check()
  else if (cmd === 'render') await render(process.argv.includes('--upload'))
  else if (cmd === 'rehearse') await rehearse()
  else throw new Error('Usage: poc.ts setup | check | render [--upload] | rehearse')
} catch (e) {
  console.log(JSON.stringify({ step: cmd, ok: false, error: String(e).slice(0, 2000) }))
  process.exit(1)
}
