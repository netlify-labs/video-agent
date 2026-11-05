// login, logout, whoami and doctor's remote checks (cli-and-sdk plan §5.2, §6.3; bead va-p1th.4.2). login approves
// this CLI in the browser (the device flow, 3.3a-c) or checks a key you paste; either way the key is never printed.
import { hostname } from 'node:os'
import { isVideoAgentError } from '../../../sdk/src/index.js'
import { readConfig, writeConfig } from '../config.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import type { Ctx, Handler } from '../router.js'

/** The key's id from nva_<keyId>_<secret> (the secret is hex, so the last underscore splits them). */
const keyIdOf = (key: string) => (key.startsWith('nva_') ? key.slice(4, key.lastIndexOf('_')) : undefined)

/** This machine's name as the server shows it: printable ASCII, at most 64 characters. */
export function hostLabel(name = hostname()): string {
  const clean = name
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 64)
  return clean || 'unknown host'
}

const unavailable = (site: string) =>
  new CliError(
    'cli_login_unavailable',
    `CLI sign-in isn't available on this server. Create a key on ${site}/keys and run: video-agent login --key -`,
    EXIT.conflict,
  )

const wait = (ctx: Ctx, ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ctx.io.pollMs ?? ms))

async function save(
  ctx: Ctx,
  values: { apiKey: string; keyId?: string | undefined; webhookSecret?: string | undefined },
) {
  const url = ctx.connection.url
  if (ctx.flags['no-save']) return null
  return writeConfig(ctx.io.configDir, {
    ...(url ? { url } : {}),
    apiKey: values.apiKey,
    ...(values.keyId ? { keyId: values.keyId } : {}),
    ...(values.webhookSecret ? { webhookSecret: values.webhookSecret } : {}),
  })
}

/** --key: check it with GET /me before keeping it. */
async function loginWithKey(ctx: Ctx, key: string) {
  const me = await ctx.sdk().me.get()
  const file = await save(ctx, { apiKey: key, keyId: keyIdOf(key) })
  ctx.log('login.key_checked', { saved: file !== null })
  return {
    json: { url: ctx.connection.url, user: { email: me.email, role: me.role }, saved: file !== null },
    text: `Signed in as ${me.email} (${me.role}) at ${ctx.connection.url}.${file ? ` Saved to ${file}.` : ' Not saved.'}`,
  }
}

const login: Handler = async (ctx) => {
  const key = ctx.flags.key as string | undefined
  if (key) return loginWithKey(ctx, key)
  if (ctx.flags['no-save'])
    throw new UsageError(
      '--no-save only goes with --key: a browser login is saved so later commands can use it.',
    )
  const sdk = ctx.sdk()
  const site = ctx.connection.url ?? ''
  // Before 3.3 or switched off: the same hint.
  const config = await sdk.config.get()
  if (!config.features.includes('cli_login')) throw unavailable(site)
  const host = hostLabel()
  let started
  try {
    started = await sdk.cliLogins.create({ label: `video-agent on ${host}`.slice(0, 64), host })
  } catch (e) {
    if (isVideoAgentError(e) && e.code === 'cli_login_disabled') throw unavailable(site)
    throw e
  }
  ctx.log('login.started', { loginId: started.loginId })
  ctx.io.stderr(`Open ${started.verificationUrl} and enter ${started.userCode}\n`)
  if (!ctx.flags['no-browser']) {
    await ctx.io.openBrowser(started.verificationUrl).catch((e: unknown) => {
      ctx.log('login.browser_failed', { error: e instanceof Error ? e.message : String(e) })
    })
  }
  ctx.io.stderr('Waiting for you to approve it in the browser…\n')
  let intervalSec = started.intervalSec
  for (;;) {
    await wait(ctx, intervalSec * 1000)
    let claim
    try {
      claim = await sdk.cliLogins.claim(started.loginId, { deviceCode: started.deviceCode })
    } catch (e) {
      if (isVideoAgentError(e) && e.code === 'cli_login_disabled') throw unavailable(site)
      throw e
    }
    ctx.log('login.poll', { status: claim.status, intervalSec })
    if (claim.status === 'pending') continue
    // RFC 8628 §3.5: slow_down adds five seconds to the interval, for good.
    if (claim.status === 'slow_down') {
      intervalSec += 5
      continue
    }
    if (claim.status === 'denied')
      throw new CliError('login_denied', 'The login was denied in the browser.', EXIT.auth)
    if (claim.status === 'expired' || !claim.apiKey)
      throw new CliError('login_expired', 'The code expired. Run video-agent login again.', EXIT.auth)
    const file = await save(ctx, {
      apiKey: claim.apiKey,
      ...(claim.keyId ? { keyId: claim.keyId } : {}),
      ...(claim.webhookSecret ? { webhookSecret: claim.webhookSecret } : {}),
    })
    const user = claim.user
    return {
      json: {
        url: ctx.connection.url,
        user: user ? { email: user.email, role: user.role } : null,
        saved: true,
      },
      text: `Signed in${user ? ` as ${user.email} (${user.role})` : ''} at ${ctx.connection.url}. Saved to ${file}.`,
    }
  }
}

const logout: Handler = async (ctx) => {
  const config = await readConfig(ctx.io.configDir)
  let revoked = false
  if (ctx.flags.revoke) {
    const keyId = config.keyId ?? (config.apiKey ? keyIdOf(config.apiKey) : undefined)
    if (!keyId || !config.apiKey)
      throw new CliError('not_signed_in', 'No saved key to revoke. Run: video-agent login', EXIT.auth)
    await ctx.sdk().keys.revoke(keyId)
    revoked = true
  }
  const had = Boolean(config.apiKey)
  if (had) await writeConfig(ctx.io.configDir, config.url ? { url: config.url } : {})
  return {
    json: { forgotten: had, revoked },
    text: !had
      ? 'No saved key.'
      : revoked
        ? 'Revoked the key on the server and forgot it here.'
        : 'Forgot the saved key. It still works until revoked: video-agent logout --revoke, or the API keys page.',
  }
}

const whoami: Handler = async (ctx) => {
  const [me, config] = await Promise.all([ctx.sdk().me.get(), ctx.sdk().config.get()])
  const version = config.version?.release ?? config.version?.commit ?? 'unknown'
  return {
    json: {
      user: { id: me.id, email: me.email, name: me.name, role: me.role },
      url: ctx.connection.url,
      key: ctx.connection.from.key,
      server: config.version,
      features: config.features,
    },
    text: [
      `${me.email} (${me.role})`,
      `server ${version} at ${ctx.connection.url} (key from ${ctx.connection.from.key})`,
      `features: ${config.features.join(', ') || 'none'}`,
    ].join('\n'),
  }
}

interface Check {
  name: string
  ok: boolean
  detail: string
}

/** The remote half of doctor; local mode adds its tools (va-p1th.5). */
const doctor: Handler = async (ctx) => {
  const checks: Check[] = []
  const major = Number(process.versions.node.split('.')[0])
  checks.push({
    name: 'node',
    ok: major >= 22,
    detail: `Node ${process.versions.node}${major >= 22 ? '' : ' (needs 22 or later)'}`,
  })
  const { url, apiKey, from } = ctx.connection
  checks.push({
    name: 'config',
    ok: Boolean(url && apiKey),
    detail: url
      ? `${url} (from ${from.url}); key ${apiKey ? `from ${from.key}` : 'not set: run video-agent login'}`
      : 'No server set: run video-agent login --url <your deployment>',
  })
  let features: string[] = []
  if (url) {
    try {
      const config = await ctx.sdk().config.get()
      features = config.features
      checks.push({
        name: 'server',
        ok: true,
        detail: `${config.version?.release ?? config.version?.commit ?? 'unknown version'}; features: ${features.join(', ') || 'none'}`,
      })
    } catch (e) {
      checks.push({ name: 'server', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
    if (apiKey && checks.at(-1)?.ok) {
      try {
        const me = await ctx.sdk().me.get()
        checks.push({ name: 'key', ok: true, detail: `acts as ${me.email} (${me.role})` })
      } catch (e) {
        checks.push({ name: 'key', ok: false, detail: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  const ok = checks.every((c) => c.ok)
  return {
    json: { ok, checks, features },
    text: checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n'),
    exit: ok ? EXIT.ok : EXIT.error,
  }
}

export const ACCOUNT_COMMANDS: Record<string, Handler> = { login, logout, whoami, doctor }
