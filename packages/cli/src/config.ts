// The config file (cli-and-sdk plan §6.2 Config): one profile in v1, { url, apiKey, keyId, webhookSecret? }, at
// <configDir>/config.json, mode 0600, written atomically. Precedence: flags, then VIDEO_AGENT_URL / VIDEO_AGENT_KEY,
// then the file.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CliError, EXIT } from './exit.js'

export interface CliConfig {
  url?: string
  apiKey?: string
  keyId?: string
  webhookSecret?: string
}

export function defaultConfigDir(env: Record<string, string | undefined>): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'video-agent')
}

export async function readConfig(dir: string): Promise<CliConfig> {
  let text: string
  try {
    text = await readFile(join(dir, 'config.json'), 'utf8')
  } catch {
    return {}
  }
  try {
    return JSON.parse(text) as CliConfig
  } catch {
    throw new CliError(
      'bad_config',
      `${join(dir, 'config.json')} isn't valid JSON. Fix or delete it.`,
      EXIT.usage,
    )
  }
}

export async function writeConfig(dir: string, config: CliConfig): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'config.json')
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
  return file
}

/** The deployment and key to use, and where each came from (for doctor and whoami). */
export function resolveConnection(
  flags: { url?: string | undefined; key?: string | undefined },
  env: Record<string, string | undefined>,
  file: CliConfig,
): { url: string | undefined; apiKey: string | undefined; from: { url: string; key: string } } {
  const pick = (flag: string | undefined, e: string | undefined, f: string | undefined) =>
    flag
      ? ([flag, 'flag'] as const)
      : e
        ? ([e, 'env'] as const)
        : f
          ? ([f, 'config'] as const)
          : ([undefined, 'none'] as const)
  const [url, urlFrom] = pick(flags.url, env.VIDEO_AGENT_URL, file.url)
  const [apiKey, keyFrom] = pick(flags.key, env.VIDEO_AGENT_KEY, file.apiKey)
  return { url: url?.replace(/\/+$/, ''), apiKey, from: { url: urlFrom, key: keyFrom } }
}
