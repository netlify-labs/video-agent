// Setup readiness: everything a stranger's deployment needs, with one actionable message per item.
import type { Deps } from '../deps.js'
import { getSettings, syncEdgeConfig } from './settings.js'

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'unknown'
export interface Check {
  id: string
  label: string
  status: CheckStatus
  detail: string
  fix?: string
}

export async function setupChecks(deps: Deps, opts: { contextIsDefault: boolean }): Promise<{ ready: boolean; checks: Check[] }> {
  const checks: Check[] = []
  const add = (c: Check) => checks.push(c)
  const siteSettings = deps.config.siteId ? `https://app.netlify.com/sites/${deps.config.siteId}` : 'https://app.netlify.com'

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
    detail: deps.config.adminEmails.length > 0 ? deps.config.adminEmails.join(', ') : 'ADMIN_EMAILS is not set.',
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

  let identity
  try {
    identity = await deps.identity.settings()
  } catch {
    identity = undefined
  }
  if (identity === null || identity === undefined) {
    add({
      id: 'identity',
      label: 'Netlify Identity',
      status: identity === null ? 'fail' : 'unknown',
      detail: identity === null ? 'Identity is not enabled on this project.' : 'Could not read Identity settings.',
      fix: `Enable Identity: ${siteSettings}/configuration/identity`,
    })
  } else {
    const wantInviteOnly = mode === 'invite-only'
    add({
      id: 'identity-registration',
      label: 'Identity registration',
      status: wantInviteOnly && !identity.disableSignup ? 'fail' : 'ok',
      detail: identity.disableSignup ? 'Invite only.' : 'Open (sign-ups are filtered by domain).',
      ...(wantInviteOnly && !identity.disableSignup ? { fix: `Set registration to "Invite only": ${siteSettings}/configuration/identity` } : {}),
    })
    add({
      id: 'identity-autoconfirm',
      label: 'Email confirmation',
      status: Array.isArray(mode) && identity.autoconfirm ? 'fail' : 'ok',
      detail: identity.autoconfirm ? 'Autoconfirm is on.' : 'People must confirm their email.',
      ...(Array.isArray(mode) && identity.autoconfirm
        ? { fix: `Turn off autoconfirm, otherwise anyone can claim an address at your domain: ${siteSettings}/configuration/identity` }
        : {}),
    })
  }

  const facts = await deps.platform.setupFacts().catch(() => null)
  add({
    id: 'runner-token',
    label: 'Run token (RUNNER_API_TOKEN)',
    status: !deps.config.runnerTokenPresent ? 'fail' : facts?.tokenValid === false ? 'fail' : facts?.tokenValid ? 'ok' : 'unknown',
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
    fix: 'Edit context/BRAND.md and context/brand.json, add your logo to context/assets/, and push.',
  })

  const ready = checks.every((c) => c.status !== 'fail') && !checks.some((c) => ['runner-token', 'identity'].includes(c.id) && c.status === 'unknown')
  return { ready, checks }
}
