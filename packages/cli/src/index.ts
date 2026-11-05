// netlify-video-agent: the video-agent command (docs/plans/2026-11-04-cli-and-sdk.md §6).
import { spawn } from 'node:child_process'
import { defaultConfigDir } from './config.js'
import type { Io } from './io.js'

export { main } from './router.js'
export { COMMANDS, GLOBAL_FLAGS, type CommandSpec } from './catalog.js'
export { EXIT, exitCodeFor } from './exit.js'
export type { Io } from './io.js'
export { VERSION } from './version.js'

/** This package's name, as published. */
export const PACKAGE_NAME = 'netlify-video-agent'

/** The real process's Io. */
export function nodeIo(): Io {
  return {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    stdin: async () => {
      let s = ''
      for await (const c of process.stdin) s += String(c)
      return s
    },
    env: process.env,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    openBrowser: async (url) => {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
    },
    configDir: defaultConfigDir(process.env),
  }
}
