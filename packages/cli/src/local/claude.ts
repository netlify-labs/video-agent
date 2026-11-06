// The Claude Code adapter (bead va-p1th.5.8; settings from spike C2, docs/spikes.md). Claude Code's sandbox wraps Bash;
// Read, Write, Edit, Glob and Grep run in-process under permission rules, so the deny-read folders are denied both
// ways. --setting-sources "" and --strict-mcp-config keep the person's own settings, hooks, MCP servers and plugins out.
import { join } from 'node:path'
import { agentEnv, denyReadPaths, NETWORK_ALLOW, type Adapter } from './agent.js'

/** The settings file a run uses (written to <ws>/.va/claude.json). */
export function claudeSettings(home?: string) {
  const deny = denyReadPaths(home)
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // No allowLocalBinding: on macOS it also opens the person's own local services (C2). The render, which needs
      // the loopback, happens outside the sandbox through the render broker (VA_RENDER_BROKER).
      network: { allowedDomains: [...NETWORK_ALLOW] },
    },
    permissions: {
      defaultMode: 'dontAsk',
      allow: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'],
      deny: [
        'WebFetch',
        'WebSearch',
        // `//` marks an absolute path in a permission rule (a single `/` is relative to the settings file).
        ...deny.flatMap((p) => [`Read(/${p}/**)`, `Read(/${p})`, `Edit(/${p}/**)`]),
      ],
    },
  }
}

export const claude: Adapter = {
  id: 'claude',
  command({ ws, prompt, env, maxTurns }) {
    const settings = join(ws, '.va', 'claude.json')
    return {
      cmd: 'claude',
      args: [
        '-p',
        prompt,
        '--verbose',
        '--output-format',
        'stream-json',
        '--permission-mode',
        'dontAsk',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--max-turns',
        String(maxTurns),
        '--settings',
        settings,
      ],
      env: agentEnv(env),
      files: { [settings]: `${JSON.stringify(claudeSettings(), null, 2)}\n` },
    }
  },
}
