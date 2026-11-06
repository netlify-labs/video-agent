// Help, from the catalog (cli-and-sdk plan §6.1). A feature-gated command shows only when the server lists its
// feature; when there's no server (or it can't be reached) it shows marked "(needs a server with <feature>)".
// Local commands are always listed; hosted-only ones say so.
import { COMMANDS, GLOBAL_FLAGS, type CommandSpec, type FlagSpec } from './catalog.js'
import { VERSION } from './version.js'

const visible = (c: CommandSpec, features: string[] | null) =>
  c.ready && (!c.feature || features === null || features.includes(c.feature))

const note = (c: CommandSpec, features: string[] | null): string[] =>
  [
    c.feature && features === null ? `needs a server with ${c.feature}` : null,
    c.needsHostedApp ? 'hosted app' : null,
    c.local ? 'works locally' : null,
  ].filter((x): x is string => x !== null)

const flagLine = (name: string, f: FlagSpec) =>
  `  --${name}${f.short ? `, -${f.short}` : ''}${f.type === 'boolean' ? '' : ` <${f.type}>`}${f.multiple ? ' (repeatable)' : ''}  ${f.description}${f.default !== undefined ? ` Default: ${String(f.default)}.` : ''}`

export function helpText(features: string[] | null, spec?: CommandSpec): string {
  if (spec) {
    const usage = [
      `video-agent ${spec.name}`,
      ...spec.args.map((a) =>
        a.required ? `<${a.name}${a.variadic ? '…' : ''}>` : `[${a.name}${a.variadic ? '…' : ''}]`,
      ),
      '[flags]',
    ].join(' ')
    const n = note(spec, features)
    return [
      `${spec.summary}${n.length ? ` (${n.join('; ')})` : ''}`,
      '',
      `Usage: ${usage}`,
      ...(spec.args.length
        ? ['', 'Arguments:', ...spec.args.map((a) => `  ${a.name}  ${a.description}`)]
        : []),
      ...(Object.keys(spec.flags).length
        ? ['', 'Flags:', ...Object.entries(spec.flags).map(([k, f]) => flagLine(k, f))]
        : []),
      '',
      'Global flags:',
      ...Object.entries(GLOBAL_FLAGS).map(([k, f]) => flagLine(k, f)),
      ...(spec.examples.length ? ['', 'Examples:', ...spec.examples.map((e) => `  ${e}`)] : []),
    ].join('\n')
  }
  const rows = COMMANDS.filter((c) => visible(c, features))
  const width = Math.max(...rows.map((c) => c.name.length))
  return [
    `video-agent ${VERSION}: make videos with a Video Agent deployment, or on this machine with your own coding agent.`,
    '',
    'Commands:',
    ...rows.map((c) => {
      const n = note(c, features).filter((x) => x.startsWith('needs'))
      return `  ${c.name.padEnd(width)}  ${c.summary}${n.length ? ` (${n.join('; ')})` : ''}`
    }),
    '',
    'Run "video-agent help <command>" for its flags. Add --json for one JSON object on stdout.',
  ].join('\n')
}

/** `help --json`: the visible catalog, or one command, with the global flags. */
export function helpJson(features: string[] | null, spec?: CommandSpec) {
  const shape = (c: CommandSpec) => ({
    name: c.name,
    summary: c.summary,
    args: c.args,
    flags: c.flags,
    examples: c.examples,
    sdk: c.sdk,
    feature: c.feature ?? null,
    needsHostedApp: c.needsHostedApp ?? false,
    local: c.local ?? false,
  })
  if (spec) return { cli: VERSION, command: shape(spec), globalFlags: GLOBAL_FLAGS }
  return {
    cli: VERSION,
    serverFeatures: features,
    commands: COMMANDS.filter((c) => visible(c, features)).map(shape),
    globalFlags: GLOBAL_FLAGS,
  }
}
