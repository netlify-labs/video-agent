// The router (cli-and-sdk plan §6.1): words → the catalog entry → parseArgs with its flags and the global ones →
// its handler. No framework. --json prints one JSON object on stdout and nothing else there; progress and prompts go
// to stderr. Errors map to the exit codes in exit.ts.
import { parseArgs } from 'node:util'
import { VideoAgent } from '../../sdk/src/index.js'
import { COMMANDS, findCommand, GLOBAL_FLAGS, type CommandSpec, type FlagSpec } from './catalog.js'
import { readConfig, resolveConnection, type CliConfig } from './config.js'
import { ACCOUNT_COMMANDS } from './commands/account.js'
import { BRIEF_COMMANDS } from './commands/brief.js'
import { LIBRARY_COMMANDS } from './commands/library.js'
import { MAKE_COMMANDS } from './commands/make.js'
import { READ_COMMANDS } from './commands/read.js'
import { SCENE_COMMANDS } from './commands/scenes.js'
import { REVIEW_COMMANDS } from './commands/review.js'
import { CliError, errorJson, EXIT, exitCodeFor, UsageError } from './exit.js'
import { helpJson, helpText } from './help.js'
import type { Io } from './io.js'
import { VERSION } from './version.js'

export interface Ctx {
  io: Io
  spec: CommandSpec
  args: string[]
  flags: Record<string, string | boolean | number | string[] | undefined>
  json: boolean
  /** One JSON line on stderr with --verbose (or VIDEO_AGENT_DEBUG=1). */
  log: (event: string, fields?: Record<string, unknown>) => void
  config: CliConfig
  connection: ReturnType<typeof resolveConnection>
  /** The SDK client for the configured deployment; throws not_configured without a URL. */
  sdk: () => VideoAgent
}

/** What a command answers: the object --json prints, and the text a person sees. */
export interface Result {
  json: unknown
  text: string
  /** Exit code after printing (doctor's failed checks); else 0. */
  exit?: number
}

export type Handler = (ctx: Ctx) => Promise<Result>

const byName = (name: string): CommandSpec => {
  const spec = COMMANDS.find((c) => c.name === name)
  if (!spec) throw new Error(`the catalog has no ${name}`)
  return spec
}

const helpHandler: Handler = async (ctx) => {
  const words = ctx.args
  const server = await serverFeatures(ctx)
  if (words.length) {
    const found = findCommand(words)
    if (!found?.spec.ready) throw unknownCommand(words.join(' '))
    return { json: helpJson(server, found.spec), text: helpText(server, found.spec) }
  }
  return { json: helpJson(server), text: helpText(server) }
}

/** Commands that exist, by catalog name. Exported so tests can register stubs. */
export const HANDLERS: Record<string, Handler> = {
  ...READ_COMMANDS,
  ...REVIEW_COMMANDS,
  ...LIBRARY_COMMANDS,
  ...MAKE_COMMANDS,
  ...SCENE_COMMANDS,
  ...ACCOUNT_COMMANDS,
  ...BRIEF_COMMANDS,
  help: helpHandler,
  version: async (ctx) => {
    let server: { commit: string | null; promptTemplate: number; release: string | null } | null = null
    if (ctx.connection.url) server = (await ctx.sdk().config.get()).version
    return {
      json: { cli: VERSION, url: ctx.connection.url ?? null, server },
      text: [
        `video-agent ${VERSION}`,
        ...(server ? [`server ${server.release ?? server.commit ?? 'unknown'} (${ctx.connection.url})`] : []),
      ].join('\n'),
    }
  },
}

/** The server's features for help: null when there's no server or it can't be reached. */
async function serverFeatures(ctx: Ctx): Promise<string[] | null> {
  if (!ctx.connection.url) return null
  try {
    return (await ctx.sdk().config.get()).features
  } catch (e) {
    ctx.log('help.config_unreachable', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/** Levenshtein distance, for "did you mean" (one row at a time). */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++)
      row.push(
        Math.min(
          (prev[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + 1,
          (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      )
    prev = row
  }
  return prev[b.length] ?? 0
}
const closest = (word: string, choices: string[]) => {
  const best = choices.map((c) => [c, distance(word, c)] as const).sort((x, y) => x[1] - y[1])[0]
  return best && best[1] <= Math.max(2, Math.floor(word.length / 3)) ? best[0] : null
}

function unknownCommand(words: string) {
  const near = closest(
    words,
    COMMANDS.filter((c) => c.ready).map((c) => c.name),
  )
  return new UsageError(
    `Unknown command "${words}".${near ? ` Did you mean "${near}"?` : ''} Run: video-agent help`,
  )
}

type ParseOption = { type: 'string' | 'boolean'; short?: string; multiple?: boolean }
const toParse = (flags: Record<string, FlagSpec>): Record<string, ParseOption> =>
  Object.fromEntries(
    Object.entries(flags).map(([k, f]) => [
      k,
      {
        type: f.type === 'boolean' ? 'boolean' : 'string',
        ...(f.short ? { short: f.short } : {}),
        ...(f.multiple ? { multiple: true } : {}),
      },
    ]),
  )

function parse(spec: CommandSpec, argv: string[]) {
  const all = { ...GLOBAL_FLAGS, ...spec.flags }
  let parsed: {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>
    positionals: string[]
  }
  try {
    parsed = parseArgs({ args: argv, options: toParse(all), allowPositionals: true, strict: true })
  } catch (e) {
    const m = /'(--?[\w-]+)'/.exec(e instanceof Error ? e.message : '')
    const flag = m?.[1]?.replace(/^-+/, '')
    const near = flag ? closest(flag, Object.keys(all)) : null
    throw new UsageError(
      `${e instanceof Error ? e.message.replace(/\. To specify.*$/s, '') : String(e)}.${near ? ` Did you mean --${near}?` : ''} Run: video-agent ${spec.name} --help`,
    )
  }
  const flags: Ctx['flags'] = {}
  for (const [k, f] of Object.entries(all)) {
    const v = parsed.values[k]
    if (v === undefined) {
      if (f.default !== undefined) flags[k] = f.default
      continue
    }
    if (f.type === 'number') {
      const n = Number(v)
      if (typeof v !== 'string' || !Number.isFinite(n)) throw new UsageError(`--${k} needs a number.`)
      flags[k] = n
    } else flags[k] = v as string | boolean | string[]
  }
  return { flags, args: parsed.positionals }
}

/** Runs the command line; resolves to the exit code. Never throws. */
export async function main(argv: string[], io: Io): Promise<number> {
  const json = argv.includes('--json')
  const verbose = argv.includes('--verbose') || io.env.VIDEO_AGENT_DEBUG === '1'
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    if (verbose) io.stderr(`${JSON.stringify({ ts: new Date(io.now()).toISOString(), event, ...fields })}\n`)
  }
  try {
    const words: string[] = []
    for (const a of argv) {
      if (a.startsWith('-')) break
      words.push(a)
    }
    // No command: help. `video-agent --version` is the usual shorthand.
    const found = words.length ? findCommand(words) : null
    if (words.length && !found) throw unknownCommand(words.slice(0, 2).join(' '))
    const spec = found?.spec ?? byName(argv.includes('--version') ? 'version' : 'help')
    if (!spec.ready)
      throw new UsageError(`"video-agent ${spec.name}" isn't in this version yet. Run: video-agent help`)
    const rest = found ? argv.slice(found.used) : argv.filter((a) => a !== '--version')
    const { flags, args } = parse(spec, rest)
    if (flags.key === '-') flags.key = (await io.stdin()).trim()
    const config = await readConfig(io.configDir)
    const connection = resolveConnection(
      { url: flags.url as string | undefined, key: flags.key as string | undefined },
      io.env,
      config,
    )
    let client: VideoAgent | null = null
    const ctx: Ctx = {
      io,
      spec,
      args,
      flags,
      json,
      log,
      config,
      connection,
      sdk: () => {
        if (!connection.url)
          throw new CliError(
            'not_configured',
            'No server set. Run: video-agent login --url <your deployment>, or set VIDEO_AGENT_URL.',
            EXIT.usage,
          )
        client ??= new VideoAgent({
          url: connection.url,
          apiKey: connection.apiKey ?? '',
          fetch: io.fetch,
          userAgent: `netlify-video-agent/${VERSION}`,
          logger: (event, f) => log(event, f),
        })
        return client
      },
    }
    if (flags.help && spec.name !== 'help') {
      const r = await helpHandler({ ...ctx, args: spec.name.split(' ') })
      return print(io, json, r)
    }
    if (spec.feature) {
      const server = await ctx.sdk().config.get()
      if (!server.features.includes(spec.feature))
        throw new CliError(
          'unsupported_by_server',
          `This server doesn't support ${spec.feature} yet (server ${server.version?.commit ?? 'unknown'}).`,
          EXIT.unsupported,
        )
    }
    const handler = HANDLERS[spec.name]
    if (!handler) throw new UsageError(`"video-agent ${spec.name}" isn't in this version yet.`)
    log('command.start', { command: spec.name })
    const result = await handler(ctx)
    log('command.done', { command: spec.name })
    return print(io, json, result)
  } catch (e) {
    const code = exitCodeFor(e)
    const body = errorJson(e)
    log('command.failed', { code: body.error.code, exit: code })
    if (json) io.stdout(`${JSON.stringify(body)}\n`)
    else
      io.stderr(
        `Error: ${body.error.message}${body.error.requestId ? ` (request ${body.error.requestId})` : ''}\n`,
      )
    return code
  }
}

function print(io: Io, json: boolean, r: Result): number {
  if (json) io.stdout(`${JSON.stringify(r.json)}\n`)
  else if (r.text) io.stdout(`${r.text}\n`)
  return r.exit ?? EXIT.ok
}
