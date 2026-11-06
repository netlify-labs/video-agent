// The Gemini CLI adapter (bead va-p1th.5.10; settings from spike C2, docs/spikes.md). Gemini loads the person's
// ~/.gemini settings, MCP servers, extensions and GEMINI.md with no flag to skip them, so each run gets its own home
// (GEMINI_CLI_HOME, in the cache, outside the workspace) holding only a minimal settings file and the person's OAuth
// credentials (0600, removed after the run). On macOS, --sandbox re-runs Gemini under Seatbelt with our profile: reads
// allowed except the secret folders, writes only in the workspace, Gemini's temp and cache folders and the run's home,
// and no connections to the host's loopback (the render happens outside, through the render broker).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentEnv, denyReadPaths, type Adapter } from './agent.js'

export const geminiHome = (ws: string) => join(ws, '..', '..', 'gemini-home')

export function geminiSeatbelt(runHome: string, home = homedir()): string {
  const q = (p: string) => JSON.stringify(p)
  const deny = denyReadPaths(home).filter((p) => !p.endsWith('/.gemini'))
  return [
    '(version 1)',
    '(allow default)',
    ...deny.map((p) => `(deny file-read* (subpath ${q(p)}))`),
    '(deny file-write*)',
    '(allow file-write*',
    '  (subpath (param "TARGET_DIR"))',
    '  (subpath (param "TMP_DIR"))',
    '  (subpath (param "CACHE_DIR"))',
    `  (subpath ${q(runHome)})`,
    '  (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/null") (literal "/dev/ptmx")',
    '  (regex #"^/dev/ttys[0-9]*$"))',
    '(deny network-outbound (remote ip "localhost:*"))',
    '',
  ].join('\n')
}

/** The person's own Gemini sign-in files, copied into the run's home. */
const AUTH_FILES = ['oauth_creds.json', 'google_accounts.json']

export const gemini: Adapter = {
  id: 'gemini',
  command({ ws, prompt, env }) {
    const runHome = geminiHome(ws)
    const dir = join(runHome, '.gemini')
    const files: Record<string, string> = {
      [join(dir, 'settings.json')]:
        `${JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }, null, 2)}\n`,
      [join(dir, 'sandbox-macos-va.sb')]: geminiSeatbelt(runHome),
    }
    for (const f of AUTH_FILES) {
      const from = join(homedir(), '.gemini', f)
      if (existsSync(from)) files[join(dir, f)] = readFileSync(from, 'utf8')
    }
    return {
      cmd: 'gemini',
      args: ['-p', prompt, '--sandbox', '--approval-mode', 'yolo', '-o', 'stream-json', '--skip-trust'],
      env: agentEnv(env, {
        GEMINI_CLI_HOME: runHome,
        ...(process.platform === 'darwin' ? { SEATBELT_PROFILE: 'va', GEMINI_SANDBOX: 'sandbox-exec' } : {}),
      }),
      files,
    }
  },
}
