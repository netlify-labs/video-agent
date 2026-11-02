// Shown while a deployment is missing settings the Deploy to Netlify form let it skip (missingSettings in
// GET /api/v1/config): on the sign-in screen, and as a banner in the app for whoever can already sign in.
import { Alert, Anchor, Code, List, Text } from '@mantine/core'
import { Link } from 'react-router'
import { $api } from '../api/client'

type Setting = 'RUNNER_API_TOKEN' | 'ALLOWED_EMAIL_DOMAINS' | 'ADMIN_EMAILS'

const WHAT: Record<Setting, string> = {
  RUNNER_API_TOKEN: 'a Netlify personal access token that starts the agent runs that make videos',
  ALLOWED_EMAIL_DOMAINS: "who can sign up: your company's email domains, comma-separated, or invite-only",
  ADMIN_EMAILS: "the first admins' email addresses, comma-separated",
}

const where = (count: number) => (
  <>
    Add {count === 1 ? 'it' : 'them'} in Netlify under <b>Project configuration → Environment variables</b>,
    then redeploy.
  </>
)

/** The settings this deployment still needs, or an empty list (also while the config loads). */
export function useMissingSettings(): Setting[] {
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  return config.data?.missingSettings ?? []
}

/** On the sign-in screen: what's missing, what each one is, and where to add it. */
export function MissingSettingsNotice() {
  const missing = useMissingSettings()
  if (missing.length === 0) return null
  return (
    <Alert color="yellow" variant="light" title="This site isn't set up yet" data-testid="missing-settings">
      <Text size="sm" mb={6}>
        It needs {missing.length === 1 ? 'this setting' : 'these settings'} before people can sign in and make
        videos:
      </Text>
      <List size="sm" spacing={4} mb={8}>
        {missing.map((m) => (
          <List.Item key={m}>
            <Code>{m}</Code>: {WHAT[m]}
          </List.Item>
        ))}
      </List>
      <Text size="sm">
        {where(missing.length)}{' '}
        <Anchor component={Link} to="/setup" inherit>
          Open the setup checklist
        </Anchor>
        .
      </Text>
    </Alert>
  )
}

/** In the app: videos can't be made yet. Admins get where to fix it; everyone else, who to ask. */
export function MissingSettingsBanner({ admin }: { admin: boolean }) {
  const missing = useMissingSettings()
  if (missing.length === 0) return null
  const names = missing.map((m, i) => (
    <span key={m}>
      {i > 0 ? (i === missing.length - 1 ? ' and ' : ', ') : null}
      <Code>{m}</Code>
    </span>
  ))
  return (
    <Alert color="yellow" variant="light" mb="lg" data-testid="missing-settings-banner">
      <Text size="sm">
        {missing.includes('RUNNER_API_TOKEN')
          ? "Videos can't be made yet: "
          : 'This site is missing a setting: '}
        {names} {missing.length === 1 ? "isn't" : "aren't"} set.{' '}
        {admin ? (
          <>
            {where(missing.length)}{' '}
            <Anchor component={Link} to="/setup" inherit>
              Setup checklist
            </Anchor>
          </>
        ) : (
          'Ask an admin to add ' + (missing.length === 1 ? 'it' : 'them') + '.'
        )}
      </Text>
    </Alert>
  )
}
