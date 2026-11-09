// /cli/approve: the browser half of `video-agent login` (cli-and-sdk plan §5.2; bead va-p1th.4.5). The person TYPES
// the code their terminal shows (never a prefilled link: that's how device-flow phishing works), sees who is asking,
// and approves or denies. Label and host come from anyone on the internet, so they're plain text, clipped to a line.
import { Alert, Button, Card, Group, Stack, Text, TextInput } from '@mantine/core'
import { useState } from 'react'
import { $api, errorMessage, type ApiErrorBody } from '../api/client'
import { PageHeader, relativeTime } from '../components/bits'

/** abcd efgh → ABCD-EFGH: letters only, upper case, a dash after the fourth. */
export function formatCode(typed: string): string {
  const letters = typed
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 8)
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters
}

const code = (e: unknown) =>
  e && typeof e === 'object' && 'error' in e ? (e as ApiErrorBody).error.code : ''

/** The server's words, except where the page can say more. */
function problem(e: unknown): string {
  if (code(e) === 'cli_login_disabled')
    return 'CLI sign-in is turned off for this video agent. Make a key on the API keys page and run: video-agent login --key -'
  return errorMessage(e)
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Text size="sm" c="var(--va-muted)" w={90} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text size="sm" truncate="end" title={value} className="va-cli-value" style={{ minWidth: 0 }}>
        {value}
      </Text>
    </Group>
  )
}

export function CliApprovePage() {
  const [typed, setTyped] = useState('')
  const [done, setDone] = useState<'approved' | 'denied' | null>(null)
  const lookup = $api.useMutation('post', '/api/v1/cli/logins/lookup')
  const decide = $api.useMutation('post', '/api/v1/cli/logins/approve', {
    onSuccess: (r) => {
      setDone(r.status)
    },
  })
  const login = lookup.data
  const userCode = formatCode(typed)
  const ready = userCode.length === 9

  if (done)
    return (
      <>
        <PageHeader title="Sign in the CLI" sub={null} />
        <Card maw={520}>
          <Text fw={500}>
            {done === 'approved'
              ? 'Approved. You can close this tab; the terminal is signed in.'
              : 'Denied. The terminal was not signed in.'}
          </Text>
        </Card>
      </>
    )

  return (
    <>
      <PageHeader
        title="Sign in the CLI"
        sub="Approve a video-agent login you just started in your terminal."
      />
      <Card maw={520}>
        {!login ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (ready) lookup.mutate({ body: { userCode } })
            }}
          >
            <Stack gap="sm">
              <TextInput
                label="Code from your terminal"
                description="Type the 8 letters video-agent login printed."
                placeholder="BCDF-GHJK"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={userCode}
                onChange={(e) => {
                  setTyped(e.currentTarget.value)
                }}
                styles={{
                  input: { fontFamily: 'var(--mantine-font-family-monospace)', letterSpacing: '0.1em' },
                }}
                data-autofocus
              />
              {lookup.error ? (
                <Alert color="red" role="alert">
                  {problem(lookup.error)}
                </Alert>
              ) : null}
              <Group>
                <Button type="submit" disabled={!ready} loading={lookup.isPending}>
                  Continue
                </Button>
              </Group>
            </Stack>
          </form>
        ) : (
          <Stack gap="sm">
            <Text fw={500}>
              Video Agent CLI on{' '}
              <span className="va-cli-host" style={{ overflowWrap: 'anywhere' }}>
                {login.host}
              </span>{' '}
              wants an API key that acts as you ({login.role}).
            </Text>
            <Stack gap={4}>
              <Line label="App" value={login.label} />
              <Line label="Computer" value={login.host} />
              <Line label="IP address" value={login.clientIp} />
              <Line label="Started" value={relativeTime(login.createdAt)} />
            </Stack>
            <Alert color="yellow" role="note">
              Only approve if you just ran video-agent login yourself.
            </Alert>
            {decide.error ? (
              <Alert color="red" role="alert">
                {problem(decide.error)}
              </Alert>
            ) : null}
            <Group>
              <Button
                loading={decide.isPending && decide.variables.body.decision === 'approve'}
                disabled={decide.isPending}
                onClick={() => {
                  decide.mutate({ body: { userCode, decision: 'approve' } })
                }}
              >
                Approve
              </Button>
              <Button
                variant="default"
                loading={decide.isPending && decide.variables.body.decision === 'deny'}
                disabled={decide.isPending}
                onClick={() => {
                  decide.mutate({ body: { userCode, decision: 'deny' } })
                }}
              >
                Deny
              </Button>
            </Group>
          </Stack>
        )}
      </Card>
    </>
  )
}
