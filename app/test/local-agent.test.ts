// Local mode's agent adapters (cli-and-sdk plan §6.5; beads va-p1th.5.7, 5.8): only allowlisted env reaches the agent,
// the deny-read folders are denied to both the shell and the file tools, the person's own config is kept out, and
// stopping a run kills everything it started.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentEnv, DENY_READ, runAgent, type Adapter } from '../../packages/cli/src/local/agent.js'
import { claude, claudeSettings } from '../../packages/cli/src/local/claude.js'

const log = () => {}

describe('agent env', () => {
  it('passes the allowlist and drops keys, tokens and cloud credentials', () => {
    const env = agentEnv({
      PATH: '/bin',
      HOME: '/home/me',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/ws/.tmp',
      VA_REPO_ROOT: '/ws',
      VA_NETLIFY_CLI: 'off',
      npm_config_userconfig: '/c/empty-npmrc',
      VIDEO_AGENT_KEY: 'nva_x',
      NETLIFY_AUTH_TOKEN: 't',
      AWS_SECRET_ACCESS_KEY: 's',
      GITHUB_TOKEN: 'g',
      OPENAI_API_KEY: 'o',
      SSH_AUTH_SOCK: '/tmp/agent',
    })
    expect(Object.keys(env).sort()).toEqual([
      'HOME',
      'LANG',
      'PATH',
      'TMPDIR',
      'VA_NETLIFY_CLI',
      'VA_REPO_ROOT',
      'npm_config_userconfig',
    ])
  })
})

describe('the Claude Code adapter', () => {
  it('runs headless with no user settings, no user MCP servers, a turn limit and its settings file', () => {
    const c = claude.command({
      ws: '/ws',
      prompt: 'Make a video',
      env: { PATH: '/bin', GITHUB_TOKEN: 'x' },
      maxTurns: 150,
    })
    expect(c.cmd).toBe('claude')
    const at = (f: string) => c.args[c.args.indexOf(f) + 1]
    expect(at('-p')).toBe('Make a video')
    expect(at('--output-format')).toBe('stream-json')
    expect(c.args).toContain('--verbose')
    expect(at('--permission-mode')).toBe('dontAsk')
    expect(at('--setting-sources')).toBe('')
    expect(c.args).toContain('--strict-mcp-config')
    expect(at('--max-turns')).toBe('150')
    expect(at('--settings')).toBe('/ws/.va/claude.json')
    expect(c.env).toEqual({ PATH: '/bin' })
    expect(Object.keys(c.files ?? {})).toEqual(['/ws/.va/claude.json'])
  })

  it('sandboxes Bash with no escape hatch, and denies the secret folders to the file tools too', () => {
    const s = claudeSettings('/home/me')
    expect(s.sandbox).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
    })
    expect(s.sandbox.network.allowedDomains).toContain('api.openverse.org')
    expect(JSON.stringify(s.sandbox)).not.toContain('allowLocalBinding')
    for (const d of DENY_READ) {
      expect(s.permissions.deny).toContain(`Read(//home/me/${d}/**)`)
      expect(s.permissions.deny).toContain(`Edit(//home/me/${d}/**)`)
    }
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']))
  })
})

/** An "agent" that is a shell script, for the process-tree tests. */
const shell = (script: string): Adapter => ({
  id: 'fixture',
  command: ({ env }) => ({ cmd: 'sh', args: ['-c', script], env }),
})

describe('runAgent', () => {
  it('logs the agent output to <ws>/.va/agent.log and reports the exit', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'va-ws-'))
    const r = await runAgent({
      adapter: shell('echo hello; echo oops >&2; exit 3'),
      ws,
      prompt: '',
      env: {},
      log,
    })
    expect(r.code).toBe(3)
    expect(r.timedOut).toBe(false)
    expect(readFileSync(r.logFile, 'utf8')).toContain('hello')
    expect(readFileSync(r.logFile, 'utf8')).toContain('oops')
  })

  it('a timeout kills the whole process tree, children included', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'va-ws-'))
    const marker = join(ws, 'child-survived')
    const r = await runAgent({
      adapter: shell(`(sleep 3; touch ${marker}) & sleep 30`),
      ws,
      prompt: '',
      env: { PATH: process.env.PATH ?? '' },
      log,
      timeoutMs: 500,
    })
    expect(r.timedOut).toBe(true)
    await new Promise((res) => setTimeout(res, 4000))
    expect(existsSync(marker)).toBe(false)
  }, 15_000)

  it('stops when the signal aborts', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'va-ws-'))
    const ac = new AbortController()
    const p = runAgent({
      adapter: shell('sleep 30'),
      ws,
      prompt: '',
      env: { PATH: process.env.PATH ?? '' },
      log,
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 200)
    const r = await p
    expect(r.signal).toBe('SIGTERM')
  })
})
