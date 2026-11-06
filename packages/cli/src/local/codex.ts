// The Codex adapter (bead va-p1th.5.9; settings from spike C2, docs/spikes.md). --ignore-user-config and --ignore-rules
// keep the person's config.toml, MCP servers and rules out. Codex's own sandbox has no deny-read setting, and macOS
// refuses a Seatbelt profile inside another (C2), so on macOS Codex runs with its sandbox off inside ours: reads
// allowed except the secret folders, writes only in the workspace (and ~/.codex, its own session state), and no
// connections to the host's loopback. Elsewhere Codex's workspace-write sandbox is the boundary.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentEnv, denyReadPaths, type Adapter } from './agent.js'

/** The Seatbelt profile a macOS run uses. */
export function codexSeatbelt(ws: string, home = homedir()): string {
  const deny = denyReadPaths(home).filter((p) => !p.endsWith('/.codex'))
  const q = (p: string) => JSON.stringify(p)
  return [
    '(version 1)',
    '(allow default)',
    ...deny.map((p) => `(deny file-read* (subpath ${q(p)}))`),
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(ws)}) (subpath ${q(join(home, '.codex'))}) (subpath "/dev") (subpath "/private/var/folders") (subpath "/private/tmp"))`,
    '(deny network-outbound (remote ip "localhost:*"))',
    '',
  ].join('\n')
}

export const codex: Adapter = {
  id: 'codex',
  command({ ws, prompt, env }) {
    const mac = process.platform === 'darwin'
    const profile = join(ws, '.va', 'codex.sb')
    const args = [
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '-C',
      ws,
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox',
      mac ? 'danger-full-access' : 'workspace-write',
      ...(mac ? [] : ['-c', 'sandbox_workspace_write.network_access=true']),
      '-c',
      'shell_environment_policy.inherit="all"',
      '--json',
      '-o',
      join(ws, '.va', 'last.txt'),
      prompt,
    ]
    return mac
      ? {
          cmd: 'sandbox-exec',
          args: ['-f', profile, 'codex', ...args],
          env: agentEnv(env),
          files: { [profile]: codexSeatbelt(ws) },
        }
      : { cmd: 'codex', args, env: agentEnv(env) }
  },
}
