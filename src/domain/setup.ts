// Setup readiness: everything a stranger's deployment needs, with one actionable message per item.
import type { Deps } from '../deps.js'
import { remotionConfigured } from './engines.js'
import { openverseStatus } from './openverse.js'
import { getSettings, syncEdgeConfig } from './settings.js'

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'unknown'
export interface Check {
  id: string
  label: string
  status: CheckStatus
  detail: string
  fix?: string
}

export async function setupChecks(
  deps: Deps,
  opts: { contextIsDefault: boolean },
): Promise<{ ready: boolean; checks: Check[] }> {
  const checks: Check[] = []
  const add = (c: Check) => checks.push(c)
  const siteSettings = deps.config.siteId
    ? `https://app.netlify.com/sites/${deps.config.siteId}`
    : 'https://app.netlify.com'

  const mode = deps.config.allowedEmailDomains
  add({
    id: 'admission',
    label: 'Who can sign up',
    status: mode === null ? 'fail' : 'ok',
    detail:
      mode === null
        ? 'ALLOWED_EMAIL_DOMAINS is not set.'
        : mode === 'invite-only'
          ? 'Invite-only.'
          : `Confirmed emails at ${mode.join(', ')}.`,
    fix: 'Set ALLOWED_EMAIL_DOMAINS to your company domains (comma-separated) or to invite-only, then redeploy.',
  })
  add({
    id: 'admins',
    label: 'First admins',
    status: deps.config.adminEmails.length > 0 ? 'ok' : 'fail',
    detail:
      deps.config.adminEmails.length > 0 ? deps.config.adminEmails.join(', ') : 'ADMIN_EMAILS is not set.',
    fix: 'Set ADMIN_EMAILS to the email addresses of the first admins, then redeploy.',
  })
  if (Array.isArray(mode)) {
    const outside = deps.config.adminEmails.filter((e) => !mode.includes(e.split('@').pop() ?? ''))
    if (outside.length) {
      add({
        id: 'admins-admissible',
        label: 'Admins can sign up',
        status: 'fail',
        detail: `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the allowed domains.`,
        fix: 'Use admin emails at an allowed domain, or add their domain.',
      })
    }
  }

  if (deps.config.authProvider === 'netlify') netlifySignInChecks(deps, add, mode)
  else await identityChecks(deps, add, mode, siteSettings)

  const facts = await deps.platform.setupFacts().catch(() => null)
  add({
    id: 'runner-token',
    label: 'Run token (RUNNER_API_TOKEN)',
    status: !deps.config.runnerTokenPresent
      ? 'fail'
      : facts?.tokenValid === false
        ? 'fail'
        : facts?.tokenValid
          ? 'ok'
          : 'unknown',
    detail: !deps.config.runnerTokenPresent
      ? 'RUNNER_API_TOKEN is not set.'
      : facts?.tokenValid === false
        ? (facts.tokenError ?? 'The token was rejected.')
        : 'Set.',
    fix: 'Create a personal access token (ideally for a dedicated account in this team) at https://app.netlify.com/user/applications and set RUNNER_API_TOKEN.',
  })
  add({
    id: 'agent-runners',
    label: 'Agent Runners',
    status: facts?.agentRunnersAvailable === false ? 'fail' : facts?.agentRunnersAvailable ? 'ok' : 'unknown',
    detail:
      facts?.agentRunnersAvailable === false
        ? 'Agent Runners is not available for this project or team (plan, AI features or credits).'
        : facts?.agentRunnersAvailable
          ? 'Available.'
          : 'Not checked yet.',
    fix: 'Agent Runners needs a credit-based plan with AI features enabled and available credits.',
  })

  try {
    await getSettings(deps)
    await syncEdgeConfig(deps)
    add({ id: 'database', label: 'Database', status: 'ok', detail: 'Connected and migrated.' })
  } catch (e) {
    add({
      id: 'database',
      label: 'Database',
      status: 'fail',
      detail: `Could not use Netlify Database: ${e instanceof Error ? e.message : String(e)}`,
      fix: 'Check the latest production deploy log for migration errors.',
    })
  }
  add({
    id: 'context',
    label: 'Company context',
    status: opts.contextIsDefault ? 'warn' : 'ok',
    detail: opts.contextIsDefault ? 'context/ still has the neutral default.' : 'Customized.',
    fix: 'Edit context/BRAND.md and context/brand.json, add your logo to context/assets/, and push. Or set BRAND_ZIP_URL to a zip of your brand kit (see context/README.md) and redeploy.',
  })

  // Optional: planning with questions needs AI Gateway; without it Plan it first is hidden and nothing else changes.
  add({
    id: 'ai-gateway',
    label: 'AI Gateway (optional)',
    status: deps.gateway.available() ? 'ok' : 'warn',
    detail: deps.gateway.available()
      ? 'Available: people can plan a video with a few questions first.'
      : "Not available on this team's plan, so planning with questions is off. Videos work as usual.",
    fix: 'AI Gateway comes with credit-based plans; Enterprise teams can ask their account manager to enable it.',
  })

  // Browsers only allow the microphone in a secure context, so recorded voice-over needs HTTPS (localhost counts).
  const secure = secureContext(deps.config.siteUrl)
  add({
    id: 'secure-context',
    label: 'HTTPS for recording',
    status: secure ? 'ok' : 'warn',
    detail: secure
      ? 'Served over HTTPS, so people can record their own voice-over.'
      : `${deps.config.siteUrl} isn't HTTPS, so browsers won't let people record a voice-over. Everything else works.`,
    fix: `Serve the site over HTTPS: Netlify provisions a certificate for every domain at ${siteSettings}/domain-management.`,
  })

  // Optional: music search works anonymously; a registered Openverse app gets its own rate limits.
  const music = await openverseStatus(deps)
  add({
    id: 'openverse',
    label: 'Openverse music search (optional)',
    status: music === 'registered' ? 'ok' : 'warn',
    detail: {
      registered: 'Registered app: searches use its own rate limits (once its email is verified).',
      anonymous: 'Searching anonymously, with rate limits shared by every site on the same outbound address.',
      rejected: 'Openverse refused OPENVERSE_CLIENT_ID/SECRET, so searches run anonymously.',
      unknown: "Couldn't reach Openverse to check the app.",
    }[music],
    fix: 'Run npm run setup:openverse -- --site <your site> --deploy, then click the link Openverse emails you.',
  })

  // Only where ENGINES lists Remotion (render-engines plan §7): everywhere else the row doesn't exist.
  if (remotionConfigured(deps)) add(await engineCheck(deps))

  const ready =
    checks.every((c) => c.status !== 'fail') &&
    !checks.some((c) => ['runner-token', 'identity'].includes(c.id) && c.status === 'unknown')
  return { ready, checks }
}

const INSTALL_FAILURES = ['engine_install_failed', 'engine_skills_unavailable']

/**
 * The Engines row (render-engines plan §7): whether Remotion is on and under which recorded license, and whether its
 * latest run failed to install it (the code only: nothing else keeps install failures).
 */
async function engineCheck(deps: Deps): Promise<Check> {
  const row = await deps.store.getSettings()
  const ack = row?.remotionLicenseAck ?? null
  const base = { id: 'engines', label: 'Render engines' }
  if (!ack)
    return {
      ...base,
      status: 'warn',
      detail: 'HyperFrames ✓; Remotion: in ENGINES but not set up: see Admin.',
      fix: 'Open /admin, turn Remotion on and record which Remotion license your organisation has.',
    }
  if (!row?.remotionEnabled) return { ...base, status: 'ok', detail: 'HyperFrames ✓; Remotion: off.' }
  const latest = await deps.store.latestEngineAttempt('remotion')
  if (latest?.errorCategory && INSTALL_FAILURES.includes(latest.errorCategory))
    return {
      ...base,
      status: 'warn',
      detail: `HyperFrames ✓; Remotion: last Remotion install failed: ${latest.errorCategory}.`,
      fix: 'Retry the video. If it fails again, check ENGINES and the Remotion template, then redeploy.',
    }
  const tier = ack.tier === 'free' ? 'Free License' : 'Company License'
  return {
    ...base,
    status: 'ok',
    // /api/health is public: the date only, never who recorded it (Admin shows that).
    detail: `HyperFrames ✓; Remotion: on, ${tier} recorded on ${ack.at.slice(0, 10)}; renders are reported to remotion.pro.`,
  }
}

/** What browsers treat as a secure context: an https origin, or a loopback one (local development). */
export function secureContext(siteUrl: string): boolean {
  try {
    const u = new URL(siteUrl)
    return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

async function identityChecks(
  deps: Deps,
  add: (c: Check) => void,
  mode: Deps['config']['allowedEmailDomains'],
  siteSettings: string,
) {
  let identity
  try {
    identity = await deps.identity.settings()
  } catch (e) {
    // Shown as "couldn't read" on the setup page; the cause goes to the logs.
    deps.log.warn('setup.identity_unreadable', { error: e })
    identity = undefined
  }
  if (identity === null || identity === undefined) {
    add({
      id: 'identity',
      label: 'Netlify Identity',
      status: identity === null ? 'fail' : 'unknown',
      detail:
        identity === null ? 'Identity is not enabled on this project.' : 'Could not read Identity settings.',
      fix: `Enable Identity: ${siteSettings}/configuration/identity`,
    })
  } else {
    const wantInviteOnly = mode === 'invite-only'
    add({
      id: 'identity-registration',
      label: 'Identity registration',
      status: wantInviteOnly && !identity.disableSignup ? 'fail' : 'ok',
      detail: identity.disableSignup ? 'Invite only.' : 'Open (sign-ups are filtered by domain).',
      ...(wantInviteOnly && !identity.disableSignup
        ? { fix: `Set registration to "Invite only": ${siteSettings}/configuration/identity` }
        : {}),
    })
    add({
      id: 'identity-autoconfirm',
      label: 'Email confirmation',
      status: Array.isArray(mode) && identity.autoconfirm ? 'fail' : 'ok',
      detail: identity.autoconfirm ? 'Autoconfirm is on.' : 'People must confirm their email.',
      ...(Array.isArray(mode) && identity.autoconfirm
        ? {
            fix: `Turn off autoconfirm, otherwise anyone can claim an address at your domain: ${siteSettings}/configuration/identity`,
          }
        : {}),
    })
  }
}

/** With Sign in with Netlify, Identity isn't used: the OAuth app, its redirect URI and the team rule are checked instead. */
function netlifySignInChecks(
  deps: Deps,
  add: (c: Check) => void,
  mode: Deps['config']['allowedEmailDomains'],
) {
  const redirect = `${deps.config.siteUrl}/oauth/callback`
  add({
    id: 'netlify-oauth',
    label: 'Sign in with Netlify',
    status: deps.config.netlifyOAuth ? 'ok' : 'fail',
    detail: deps.config.netlifyOAuth
      ? `OAuth app set. Its redirect URI must be ${redirect}.`
      : 'NETLIFY_OAUTH_CLIENT_ID and NETLIFY_OAUTH_CLIENT_SECRET are not set.',
    fix: `Create an OAuth application at https://app.netlify.com/user/applications with the redirect URI ${redirect}, set NETLIFY_OAUTH_CLIENT_ID and NETLIFY_OAUTH_CLIENT_SECRET, then redeploy.`,
  })
  const teams = deps.config.netlifyRequiredTeams
  add({
    id: 'netlify-team',
    label: 'Netlify team rule',
    status: teams.length > 0 ? 'ok' : 'warn',
    detail:
      teams.length > 0
        ? `Members of the ${teams.join(' or ')} Netlify team, re-checked daily.`
        : mode === 'invite-only'
          ? 'No team rule: only people who already have an account (and ADMIN_EMAILS) can sign in.'
          : 'No team rule: anyone with a Netlify account at an allowed email domain can sign in.',
    fix: 'Set NETLIFY_REQUIRED_TEAM to your Netlify team slug or id (comma-separated for several), then redeploy.',
  })
}
