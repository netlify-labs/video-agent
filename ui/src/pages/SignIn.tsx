import {
  Alert,
  Anchor,
  Button,
  Card,
  Center,
  Group,
  PasswordInput,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
  useComputedColorScheme,
} from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { $api } from '../api/client'
import { useAuth } from '../auth'
import { brand } from '../theme'
import { Mark, PoweredBy } from '../components/bits'

export function AuthPages({ setupReady }: { setupReady: boolean }) {
  const logo = useComputedColorScheme('dark') === 'light' ? (brand.logoLight ?? brand.logo) : brand.logo
  const auth = useAuth()
  const config = $api.useQuery('get', '/api/v1/config')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // A Sign in with Netlify that was refused comes back as ?signin_error=… (src/auth/web.ts).
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('signin_error'),
  )
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('signin_error')) return
    url.searchParams.delete('signin_error')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }, [])
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const admission = config.data?.admission
  const inviteOnly = admission === 'invite-only' || admission === null

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await fn()
      if (ok) setInfo(ok)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const card = (children: React.ReactNode) => (
    <Center mih="100vh" p="md">
      <Card p="xl" w="100%" maw={420}>
        <Stack>
          <div>
            <Group gap={10} mb="md">
              {logo ? <img src={logo} alt="" height={36} /> : <Mark size={28} />}
              <Title order={1}>{brand.appName}</Title>
            </Group>
            <Text c="var(--va-muted)" size="sm">
              Describe a video. An agent makes it in a few minutes.
            </Text>
          </div>
          {auth.notice ? (
            <Alert
              color={auth.noticeTone === 'warn' ? 'yellow' : 'green'}
              withCloseButton
              onClose={auth.clearNotice}
            >
              {auth.notice}
            </Alert>
          ) : null}
          {error ? <Alert color="red">{error}</Alert> : null}
          {info ? <Alert color="blue">{info}</Alert> : null}
          {children}
          {!setupReady ? (
            <Text size="xs" c="dimmed">
              Setting this up?{' '}
              <Anchor component={Link} to="/setup">
                Open the setup checklist
              </Anchor>
              .
            </Text>
          ) : null}
        </Stack>
      </Card>
      <PoweredBy />
    </Center>
  )

  if (auth.provider === 'netlify') {
    const teams = config.data?.requiredTeams ?? []
    const back = window.location.pathname + window.location.search
    return card(
      <Stack>
        <Button
          component="a"
          href={`/auth/netlify/start?return_to=${encodeURIComponent(back)}`}
          size="md"
          leftSection={<NetlifyMark />}
        >
          Sign in with Netlify
        </Button>
        <Text size="sm" c="dimmed">
          {signInRule(admission, teams)}
        </Text>
      </Stack>,
    )
  }

  if (auth.pending) {
    const invite = auth.pending.kind === 'invite'
    return card(
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => (invite ? auth.acceptInvite(password) : auth.recoverPassword(password)))
        }}
      >
        <Stack>
          <Text fw={600}>{invite ? 'Accept your invite: choose a password' : 'Choose a new password'}</Text>
          <PasswordInput
            label="Password"
            minLength={8}
            required
            value={password}
            onChange={(e) => {
              setPassword(e.currentTarget.value)
            }}
          />
          <Button type="submit" loading={busy}>
            {invite ? 'Join' : 'Save password'}
          </Button>
        </Stack>
      </form>,
    )
  }

  const domains = Array.isArray(admission) ? admission.join(', ') : null
  return card(
    <Tabs defaultValue="signin">
      <Tabs.List grow mb="md">
        <Tabs.Tab value="signin">Sign in</Tabs.Tab>
        {!inviteOnly ? <Tabs.Tab value="signup">Create account</Tabs.Tab> : null}
      </Tabs.List>
      <Tabs.Panel value="signin">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => auth.login(email, password))
          }}
        >
          <Stack>
            <TextInput
              label="Email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.currentTarget.value)
              }}
            />
            <PasswordInput
              label="Password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.currentTarget.value)
              }}
            />
            <Button type="submit" loading={busy}>
              Sign in
            </Button>
            <Anchor
              component="button"
              type="button"
              size="sm"
              onClick={() => {
                if (!email) {
                  setError('Enter your email first.')
                  return
                }
                void run(
                  () => auth.requestPasswordRecovery(email),
                  'If that address has an account, a reset link is on its way.',
                )
              }}
            >
              Forgot your password?
            </Anchor>
            {inviteOnly ? (
              <Text size="sm" c="dimmed">
                This video agent is invite-only. Ask an admin for an invite.
              </Text>
            ) : null}
          </Stack>
        </form>
      </Tabs.Panel>
      <Tabs.Panel value="signup">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run(
              () => auth.signup(email, password),
              'Check your email for a confirmation link, then sign in.',
            )
          }}
        >
          <Stack>
            {domains ? (
              <Text size="sm" c="dimmed">
                Use your {domains} email address.
              </Text>
            ) : null}
            <TextInput
              label="Work email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.currentTarget.value)
              }}
            />
            <PasswordInput
              label="Password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.currentTarget.value)
              }}
            />
            <Button type="submit" loading={busy}>
              Create account
            </Button>
          </Stack>
        </form>
      </Tabs.Panel>
    </Tabs>,
  )
}

/** Who can sign in with Netlify here, in plain words. */
function signInRule(admission: string[] | 'invite-only' | null | undefined, teams: string[]): string {
  const team = teams.length > 0 ? ` You need to be a member of the ${teams.join(' or ')} Netlify team.` : ''
  if (Array.isArray(admission))
    return `Use the Netlify account for your ${admission.join(' or ')} email address.${team}`
  if (admission === 'invite-only') return `Only people who already have an account here can sign in.${team}`
  return `Use your Netlify account.${team}`
}

function NetlifyMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 2 2 12l10 10 10-10L12 2Zm0 4.2L17.8 12 12 17.8 6.2 12 12 6.2Z" />
    </svg>
  )
}
