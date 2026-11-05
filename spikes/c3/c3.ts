// Spike C3 (docs/plans/2026-11-04-cli-and-sdk.md §11 phase 0; bead va-p1th.1.3): Kokoro voice-over from a private
// venv, so local mode never changes the person's Python (no --user, no --break-system-packages).
//   npx tsx spikes/c3/c3.ts [--cache <dir>] [--python <python3.x>]
// Steps (one JSON line each, with ms and outcome): python (version, 3.10+), venv (python3 -m venv), install
// (kokoro-onnx + soundfile into the venv, with a pip --report of every download URL), speak (one line through
// `hyperframes tts` with HYPERFRAMES_PYTHON=<venv python> and HOME redirected, so the model lands in our cache),
// again (a second line, cached), hosts (every host a first run contacts: pip downloads and the model URLs' redirect
// targets), user-python (the user site-packages and `pip list --user` unchanged). Spends nothing.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..', '..')
/**
 * The interpreter for the venv: --python, else the newest of python3.13…3.10, else python3. Python 3.14's
 * espeakng-loader wheel (0.2.4, macOS) points espeak-ng at its build machine's data path, so Kokoro fails there.
 */
const which = (bin: string) =>
  spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim()
const PY =
  (process.argv.includes('--python') ? process.argv[process.argv.indexOf('--python') + 1] : undefined) ??
  (['python3.13', 'python3.12', 'python3.11', 'python3.10'].map(which).find(Boolean) || 'python3')
const argv = process.argv.slice(2)
const cache = argv.includes('--cache') ? argv[argv.indexOf('--cache') + 1]! : join(tmpdir(), 'va-c3')
const venv = join(cache, 'kokoro-venv')
const home = join(cache, 'home')
const py = join(venv, 'bin', 'python')
const MODEL_URLS = [
  'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx',
  'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin',
]

const log = (step: string, f: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), platform: process.platform, step, ...f }))
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
      error: e instanceof Error ? e.message.slice(0, 1500) : String(e),
    })
    throw e
  }
}
// The person's pip config never applies (indexes, credentials), and nothing prompts.
const pipEnv = {
  ...process.env,
  PIP_CONFIG_FILE: devNull,
  PIP_NO_INPUT: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
}
const userSite = () => {
  const site = execFileSync('python3', ['-c', 'import site; print(site.getusersitepackages())'], {
    encoding: 'utf8',
  }).trim()
  const listing = existsSync(site)
    ? readdirSync(site)
        .sort()
        .map((n) => `${n}:${statSync(join(site, n)).mtimeMs}`)
        .join('|')
    : 'absent'
  const pipUser = spawnSync('python3', ['-m', 'pip', 'list', '--user', '--format=freeze'], {
    env: pipEnv,
    encoding: 'utf8',
  })
  return { site, listing, pipUser: pipUser.status === 0 ? pipUser.stdout : `exit ${pipUser.status}` }
}
const before = userSite()
mkdirSync(cache, { recursive: true })

await step('python', () => {
  const v = execFileSync(PY, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], {
    encoding: 'utf8',
  }).trim()
  const [maj, min] = v.split('.').map(Number) as [number, number]
  if (maj < 3 || (maj === 3 && min < 10)) throw new Error(`python3 is ${v}; Kokoro needs 3.10+`)
  return { python: v, path: which(PY) || PY, systemPython3: which('python3') }
})

await step('venv', () => {
  if (!existsSync(py)) execFileSync(PY, ['-m', 'venv', venv])
  return { venv }
})

const report = join(cache, 'pip-report.json')
await step('install', () => {
  execFileSync(py, ['-m', 'pip', 'install', '--quiet', '--report', report, 'kokoro-onnx', 'soundfile'], {
    env: pipEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  execFileSync(py, ['-c', 'import kokoro_onnx, soundfile'])
  const r = JSON.parse(readFileSync(report, 'utf8')) as {
    install: { metadata: { name: string; version: string } }[]
  }
  return {
    packages: r.install.length,
    kokoro: r.install.find((p) => p.metadata.name === 'kokoro-onnx')?.metadata.version,
  }
})

const speak = (text: string, name: string) => {
  mkdirSync(home, { recursive: true })
  const dir = join(cache, 'lines')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.txt`), text)
  const out = join(dir, `${name}.wav`)
  const r = spawnSync(
    join(repo, 'node_modules/.bin/hyperframes'),
    ['tts', join(dir, `${name}.txt`), '-o', out, '--voice', 'af_heart'],
    { env: { ...process.env, HOME: home, HYPERFRAMES_PYTHON: py }, encoding: 'utf8' },
  )
  if (r.status !== 0 || !existsSync(out))
    throw new Error(`hyperframes tts exited ${r.status}: ${(r.stderr || r.stdout).slice(-800)}`)
  const sec = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], {
      encoding: 'utf8',
    }).trim(),
  )
  return { wavBytes: statSync(out).size, durationSec: sec }
}
await step('speak', () =>
  speak('Make one on your laptop in three minutes, then deploy it for your team.', 'first'),
)
await step('again', () => speak('The second line uses the cached model.', 'second'))

await step('hosts', async () => {
  const r = JSON.parse(readFileSync(report, 'utf8')) as { install: { download_info?: { url?: string } }[] }
  const pip = [
    ...new Set(
      r.install.map((p) => p.download_info?.url && new URL(p.download_info.url).host).filter(Boolean),
    ),
  ]
  const model: string[] = []
  for (const u of MODEL_URLS) {
    model.push(new URL(u).host)
    const res = await fetch(u, { method: 'HEAD', redirect: 'manual' })
    const loc = res.headers.get('location')
    if (loc) model.push(new URL(loc).host)
  }
  const modelDir = join(home, '.cache', 'hyperframes', 'tts')
  return {
    pip: pip.length ? pip : ['pypi.org (index)', 'files.pythonhosted.org'],
    pipIndex: 'pypi.org',
    model: [...new Set(model)],
    modelCache: existsSync(modelDir) ? readdirSync(modelDir, { recursive: true }).length : 0,
  }
})

await step('user-python', () => {
  const after = userSite()
  if (after.listing !== before.listing || after.pipUser !== before.pipUser)
    throw new Error(`the user's Python changed: ${JSON.stringify({ before, after }).slice(0, 800)}`)
  return { untouched: after.site }
})
