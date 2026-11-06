// The CLI's router, help, exit codes, config and logging, in process through main(argv, io) (cli-and-sdk plan §6.1,
// §6.2). Nothing here touches the real home, network or browser.
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VideoAgentError } from '../../sdk/src/index.js'
import { COMMANDS, type CommandSpec } from '../src/catalog.js'
import { readConfig, resolveConnection, writeConfig } from '../src/config.js'
import { EXIT, exitCodeFor, UsageError } from '../src/exit.js'
import type { Io } from '../src/io.js'
import { HANDLERS, main } from '../src/router.js'
import { VERSION } from '../src/version.js'

const SITE = 'https://video.example.com'
const everything: string[] = []

function makeIo(
  o: { env?: Record<string, string>; features?: string[] | 'down'; stdin?: string; configDir?: string } = {},
) {
  const out = { stdout: '', stderr: '', requests: [] as { url: string; auth: string | null }[] }
  const io: Io = {
    stdout: (t) => {
      out.stdout += t
      everything.push(t)
    },
    stderr: (t) => {
      out.stderr += t
      everything.push(t)
    },
    stdin: async () => o.stdin ?? '',
    env: o.env ?? {},
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      out.requests.push({ url: req.url, auth: req.headers.get('authorization') })
      if (o.features === 'down') throw new TypeError('fetch failed')
      if (new URL(req.url).pathname === '/api/v1/config')
        return Response.json(
          { version: { commit: 'abc123', promptTemplate: 16, release: null }, features: o.features ?? [] },
          { headers: { 'x-nf-request-id': 'req_cfg' } },
        )
      return Response.json({ error: { code: 'not_found', message: 'No route.' } }, { status: 404 })
    },
    now: () => Date.UTC(2026, 10, 5),
    openBrowser: async () => undefined,
    configDir: o.configDir ?? mkdtempSync(join(tmpdir(), 'va-cli-')),
  }
  return { io, out, run: (argv: string[]) => main(argv, io) }
}

const stub: CommandSpec = {
  name: 'stub-gated',
  summary: 'A stub that needs looks.',
  args: [],
  flags: {},
  examples: [],
  sdk: [],
  feature: 'looks',
  ready: true,
}

describe('router', () => {
  afterEach(() => {
    const i = COMMANDS.indexOf(stub)
    if (i >= 0) COMMANDS.splice(i, 1)
    delete HANDLERS['stub-gated']
  })

  it('help lists the ready commands; help <command> shows its flags', async () => {
    const t = makeIo()
    expect(await t.run([])).toBe(0)
    expect(t.out.stdout).toContain('Commands:')
    expect(t.out.stdout).toMatch(/^\s+help\s+List the commands/m)
    // A command that isn't ready yet is never listed.
    const notReady = COMMANDS.find((c) => !c.ready)?.name ?? 'none'
    expect(t.out.stdout).not.toMatch(new RegExp(`^\\s+${notReady}\\s`, 'm'))
    await expect(t.out.stdout).toMatchFileSnapshot('./__snapshots__/help.txt')
    const one = makeIo()
    expect(await one.run(['help', 'version'])).toBe(0)
    expect(one.out.stdout).toContain('Usage: video-agent version [flags]')
    expect(one.out.stdout).toContain('--json')
  })

  it('--json prints exactly one JSON object on stdout, for success and for errors', async () => {
    for (const argv of [
      ['help', '--json'],
      ['version', '--json'],
      ['nope', '--json'],
      ['help', '--bogus', '--json'],
    ]) {
      const t = makeIo()
      await t.run(argv)
      expect(t.out.stdout.trim().split('\n'), argv.join(' ')).toHaveLength(1)
      expect(() => JSON.parse(t.out.stdout) as unknown, argv.join(' ')).not.toThrow()
    }
    const t = makeIo()
    await t.run(['help', '--json'])
    const body = JSON.parse(t.out.stdout) as { cli: string; commands: { name: string }[] }
    expect(body.cli).toBe(VERSION)
    expect(body.commands.map((c) => c.name)).toEqual(COMMANDS.filter((c) => c.ready).map((c) => c.name))
    expect(body.commands.map((c) => c.name)).toEqual(expect.arrayContaining(['help', 'version']))
    await expect(`${JSON.stringify(body, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/help.json.txt')
  })

  it('unknown commands and flags exit 2 with a suggestion', async () => {
    const a = makeIo()
    expect(await a.run(['hlep'])).toBe(EXIT.usage)
    expect(a.out.stderr).toContain('Did you mean "help"?')
    const b = makeIo()
    expect(await b.run(['version', '--jsno'])).toBe(EXIT.usage)
    expect(b.out.stderr).toContain('Did you mean --json?')
    // A command in the catalog that isn't built yet (none once every bead has landed).
    const notReady = COMMANDS.find((x) => !x.ready)?.name
    if (notReady) {
      const c = makeIo()
      expect(await c.run(['help', ...notReady.split(' ')])).toBe(EXIT.usage)
      const d = makeIo()
      expect(await d.run([...notReady.split(' '), 'vid_1', 'x'])).toBe(EXIT.usage)
      expect(d.out.stderr).toContain("isn't in this version yet")
    }
  })

  it('version reports the server when one is configured', async () => {
    const t = makeIo({ env: { VIDEO_AGENT_URL: SITE } })
    expect(await t.run(['version', '--json'])).toBe(0)
    expect(JSON.parse(t.out.stdout)).toEqual({
      cli: VERSION,
      url: SITE,
      server: { commit: 'abc123', promptTemplate: 16, release: null },
    })
    const bare = makeIo()
    expect(await bare.run(['--version'])).toBe(0)
    expect(bare.out.stdout).toBe(`video-agent ${VERSION}\n`)
  })

  it('a feature-gated command is hidden without its feature and exits 9 when invoked', async () => {
    COMMANDS.push(stub)
    HANDLERS['stub-gated'] = async () => ({ json: { ok: true }, text: 'ok' })
    const without = makeIo({ env: { VIDEO_AGENT_URL: SITE }, features: ['remix'] })
    await without.run(['help'])
    expect(without.out.stdout).not.toContain('stub-gated')
    expect(await without.run(['stub-gated'])).toBe(EXIT.unsupported)
    expect(without.out.stderr).toContain("This server doesn't support looks yet (server abc123).")
    const withIt = makeIo({ env: { VIDEO_AGENT_URL: SITE }, features: ['looks'] })
    await withIt.run(['help'])
    expect(withIt.out.stdout).toContain('stub-gated')
    expect(await withIt.run(['stub-gated', '--json'])).toBe(0)
    // No server, or one that can't be reached: listed, marked.
    for (const t of [makeIo(), makeIo({ env: { VIDEO_AGENT_URL: SITE }, features: 'down' })]) {
      await t.run(['help'])
      expect(t.out.stdout).toContain('stub-gated')
      expect(t.out.stdout).toContain('(needs a server with looks)')
    }
  })

  it('--verbose logs requests and steps as JSON lines on stderr, never the key', async () => {
    const t = makeIo({ env: { VIDEO_AGENT_URL: SITE, VIDEO_AGENT_KEY: 'nva_secret_key' } })
    expect(await t.run(['version', '--verbose'])).toBe(0)
    const lines = t.out.stderr
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.find((l) => l.event === 'request')).toMatchObject({
      method: 'GET',
      path: '/api/v1/config',
      status: 200,
      attempt: 1,
      requestId: 'req_cfg',
    })
    expect(lines.map((l) => l.event)).toEqual(expect.arrayContaining(['command.start', 'command.done']))
    expect(t.out.requests[0]?.auth).toBe('Bearer nva_secret_key')
    const debug = makeIo({ env: { VIDEO_AGENT_DEBUG: '1' } })
    await debug.run(['version'])
    expect(debug.out.stderr).toContain('"event":"command.start"')
  })

  it('--key - reads the key from stdin', async () => {
    const t = makeIo({ env: { VIDEO_AGENT_URL: SITE }, stdin: 'nva_from_stdin\n' })
    expect(await t.run(['version', '--key', '-'])).toBe(0)
    expect(t.out.requests[0]?.auth).toBe('Bearer nva_from_stdin')
  })

  it('never prints a key', () => {
    expect(everything.join('')).not.toMatch(/nva_[a-z]/)
  })
})

describe('exit codes', () => {
  const err = (status: number, code: string) => new VideoAgentError({ status, code, message: code })
  it.each([
    [err(500, 'internal'), EXIT.error],
    [err(0, 'network'), EXIT.error],
    [err(400, 'invalid_request'), EXIT.usage],
    [err(400, 'unknown_look'), EXIT.usage],
    [err(0, 'invalid_ref'), EXIT.usage],
    [err(401, 'unauthorized'), EXIT.auth],
    [err(403, 'forbidden'), EXIT.notFound],
    [err(404, 'not_found'), EXIT.notFound],
    [err(0, 'video_failed'), EXIT.videoFailed],
    [err(0, 'wait_timeout'), EXIT.waitTimeout],
    [err(409, 'conflict'), EXIT.conflict],
    [err(409, 'remix_disabled'), EXIT.conflict],
    [err(409, 'cli_login_disabled'), EXIT.conflict],
    [err(429, 'rate_limited'), EXIT.rateLimited],
    [err(0, 'unsupported_by_server'), EXIT.unsupported],
    [new UsageError('bad flag'), EXIT.usage],
    [new Error('anything else'), EXIT.error],
  ])('%s → %i', (e, exit) => {
    expect(exitCodeFor(e)).toBe(exit)
  })
})

describe('config', () => {
  it('flags beat the environment, which beats the file', () => {
    const file = { url: 'https://file.example', apiKey: 'nva_file' }
    const env = { VIDEO_AGENT_URL: 'https://env.example', VIDEO_AGENT_KEY: 'nva_env' }
    expect(resolveConnection({ url: 'https://flag.example/', key: 'nva_flag' }, env, file)).toEqual({
      url: 'https://flag.example',
      apiKey: 'nva_flag',
      from: { url: 'flag', key: 'flag' },
    })
    expect(resolveConnection({}, env, file).from).toEqual({ url: 'env', key: 'env' })
    expect(resolveConnection({}, {}, file).from).toEqual({ url: 'config', key: 'config' })
    expect(resolveConnection({}, {}, {}).url).toBeUndefined()
  })

  it('writes config.json with mode 0600 and reads it back; the CLI uses it', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'va-xdg-')), 'video-agent')
    const path = await writeConfig(dir, { url: SITE, apiKey: 'nva_saved', keyId: 'key_1' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(await readConfig(dir)).toEqual({ url: SITE, apiKey: 'nva_saved', keyId: 'key_1' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ keyId: 'key_1' })
    const t = makeIo({ configDir: dir })
    expect(await t.run(['version', '--json'])).toBe(0)
    expect(t.out.requests[0]?.auth).toBe('Bearer nva_saved')
  })

  it('a broken config file is a usage error that names it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-bad-'))
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'config.json'), '{nope')
    const t = makeIo({ configDir: dir })
    expect(await t.run(['version'])).toBe(EXIT.usage)
    expect(t.out.stderr).toContain('config.json')
  })
})

it('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
  expect(VERSION).toBe(pkg.version)
})
