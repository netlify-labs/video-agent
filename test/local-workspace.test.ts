// Local mode's runtime install and workspace (cli-and-sdk plan §7; bead va-p1th.5.5), against the real runtime build
// with npm and netlify-agent-kit stubbed (the end-to-end install on Linux is the phase 4 gate's CI job, va-p1th.5.17).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildWorkspace,
  cacheDir,
  ensureRuntime,
  installAgentKit,
  type Runner,
} from '../packages/cli/src/local/workspace.js'
import { buildRuntime, RUNTIME_SCRIPTS } from '../scripts/lib/cli-runtime.js'
import { repoRoot } from '../scripts/lib/run-tools.js'

let source = ''
beforeAll(async () => {
  source = mkdtempSync(join(tmpdir(), 'va-runtime-src-'))
  await buildRuntime({ repo: repoRoot, out: source, lockfile: false })
  writeFileSync(join(source, 'package-lock.json'), '{"lockfileVersion":3}\n')
}, 120_000)

/** A fake npm ci (it makes node_modules/.bin) and agent-kit (it adds a skill), recording each call. */
function stubs() {
  const calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = []
  const run: Runner = (cmd, args, o) => {
    calls.push({ cmd, args, ...o })
    if (cmd === 'npm') mkdirSync(join(o.cwd, 'node_modules', '.bin'), { recursive: true })
    else mkdirSync(join(o.cwd, '.claude', 'skills', 'hyperframes'), { recursive: true })
    return { status: 0, output: '' }
  }
  return { calls, run }
}
const logs: { event: string; fields?: Record<string, unknown> }[] = []
const log = (event: string, fields?: Record<string, unknown>) =>
  void logs.push({ event, ...(fields ? { fields } : {}) })

describe('local runtime', () => {
  it('lives under $XDG_CACHE_HOME/video-agent', () => {
    expect(cacheDir({ XDG_CACHE_HOME: '/x/cache' })).toBe('/x/cache/video-agent')
  })

  it('installs once with an empty npm config, then reuses it; a new lockfile reinstalls', () => {
    const cache = mkdtempSync(join(tmpdir(), 'va-cache-'))
    const s = stubs()
    const env = { PATH: '/usr/bin', npm_config_userconfig: '/home/me/.npmrc' }
    const dir = ensureRuntime({ source, cache, version: '0.1.0', env, log, run: s.run })
    expect(dir).toBe(join(cache, 'runtime', '0.1.0'))
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({
      cmd: 'npm',
      args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    })
    expect(s.calls[0]!.env.npm_config_userconfig).toBe(join(cache, 'empty-npmrc'))
    expect(readFileSync(join(cache, 'empty-npmrc'), 'utf8')).toBe('')
    expect(existsSync(join(dir, 'render-job.mjs'))).toBe(true)

    ensureRuntime({ source, cache, version: '0.1.0', env, log, run: s.run, offline: true })
    expect(s.calls).toHaveLength(1)

    writeFileSync(join(source, 'package-lock.json'), '{"lockfileVersion":3,"x":1}\n')
    ensureRuntime({ source, cache, version: '0.1.0', env, log, run: s.run })
    expect(s.calls).toHaveLength(2)
  })

  it('a failed install says so, with npm output, and is retried next time', () => {
    const cache = mkdtempSync(join(tmpdir(), 'va-cache-'))
    const fail: Runner = () => ({ status: 1, output: 'npm ERR! network' })
    expect(() => ensureRuntime({ source, cache, version: '0.1.0', env: {}, log, run: fail })).toThrow(
      /Installing the video-agent runtime failed[\s\S]*npm ERR! network/,
    )
    const s = stubs()
    ensureRuntime({ source, cache, version: '0.1.0', env: {}, log, run: s.run })
    expect(s.calls).toHaveLength(1)
  })
})

describe('local workspace', () => {
  it('shims every run script, links node_modules, puts pinned tools first and turns Blobs off', () => {
    const cache = mkdtempSync(join(tmpdir(), 'va-cache-'))
    const runtime = ensureRuntime({ source, cache, version: '0.1.0', env: {}, log, run: stubs().run })
    const ws = buildWorkspace({ runtime, cache, runId: 'loc_1', env: { PATH: '/usr/bin' }, log })
    expect(ws.dir).toBe(join(cache, 'runs', 'loc_1'))
    for (const s of RUNTIME_SCRIPTS)
      expect(readFileSync(join(ws.dir, 'scripts', `${s}.ts`), 'utf8')).toBe(
        `import ${JSON.stringify(join(runtime, `${s}.mjs`))}\n`,
      )
    expect(readlinkSync(join(ws.dir, 'node_modules'))).toBe(join(runtime, 'node_modules'))
    expect(readlinkSync(join(ws.dir, 'video', 'node_modules'))).toBe(join(runtime, 'node_modules'))
    for (const f of ['video/index.html', 'context/BRAND.md', 'AGENTS.md'])
      expect(existsSync(join(ws.dir, f)), f).toBe(true)
    expect(JSON.parse(readFileSync(join(ws.dir, 'package.json'), 'utf8'))).toHaveProperty('netlifyAgent')
    expect(ws.env.PATH?.split(delimiter)).toEqual([
      join(runtime, 'node_modules', '.bin'),
      join(cache, 'agent-kit-home', '.local', 'bin'),
      '/usr/bin',
    ])
    expect(ws.env).toMatchObject({
      VA_REPO_ROOT: ws.dir,
      VA_NETLIFY_CLI: 'off',
      npm_config_userconfig: join(cache, 'empty-npmrc'),
    })
    expect(logs.some((l) => l.event === 'local.workspace')).toBe(true)
  })

  it('--context replaces the neutral context', () => {
    const cache = mkdtempSync(join(tmpdir(), 'va-cache-'))
    const runtime = ensureRuntime({ source, cache, version: '0.1.0', env: {}, log, run: stubs().run })
    const mine = mkdtempSync(join(tmpdir(), 'va-ctx-'))
    writeFileSync(join(mine, 'BRAND.md'), '# Acme\n')
    const ws = buildWorkspace({ runtime, cache, runId: 'loc_2', env: {}, log, context: mine })
    expect(readFileSync(join(ws.dir, 'context', 'BRAND.md'), 'utf8')).toBe('# Acme\n')
    expect(existsSync(join(ws.dir, 'context', 'brand.json'))).toBe(false)
  })

  it('agent-kit installs into the workspace with HOME redirected, never the real one', () => {
    const cache = mkdtempSync(join(tmpdir(), 'va-cache-'))
    const s = stubs()
    const runtime = ensureRuntime({ source, cache, version: '0.1.0', env: {}, log, run: s.run })
    const ws = buildWorkspace({ runtime, cache, runId: 'loc_3', env: { HOME: '/home/me' }, log })
    expect(installAgentKit({ ws, runtime, log, run: s.run })).toEqual(['hyperframes'])
    const kit = s.calls.at(-1)!
    expect(kit.cmd).toBe(join(runtime, 'node_modules', '.bin', 'netlify-agent-kit'))
    expect(kit.args).toEqual(['install', '--force'])
    expect(kit.cwd).toBe(ws.dir)
    expect(kit.env.HOME).toBe(join(cache, 'agent-kit-home'))
  })
})
