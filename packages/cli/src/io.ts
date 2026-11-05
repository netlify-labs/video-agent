// The CLI's whole contact with the outside world, passed into main() so every command runs in-process in tests
// without the real home, network, clock or browser.
export interface Io {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** All of stdin, for '-' arguments. */
  stdin: () => Promise<string>
  env: Record<string, string | undefined>
  fetch: typeof fetch
  now: () => number
  openBrowser: (url: string) => Promise<void>
  /** Where config.json lives: $XDG_CONFIG_HOME/video-agent, else ~/.config/video-agent. */
  configDir: string
  /** Poll interval for waits; tests set 0. Unset: the SDK's own (3 s, then 8 s). */
  pollMs?: number
}
