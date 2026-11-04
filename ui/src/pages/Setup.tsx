import { Alert, Anchor, Button, Card, Group, Stack, Text } from '@mantine/core'
import { $api } from '../api/client'
import { Mark, PageHeader } from '../components/bits'

const WORD = { ok: 'Done', fail: 'Needs fixing', warn: 'Recommended', unknown: 'Not checked' } as const
const STATE = { ok: 'ready', fail: 'failed', warn: 'idle', unknown: 'idle' } as const

function linkify(text: string) {
  return text.split(/(https:\/\/\S+)/g).map((p, i) =>
    p.startsWith('https://') ? (
      <Anchor key={i} href={p.replace(/[.,]$/, '')} target="_blank" c="var(--va-text)">
        {p}
      </Anchor>
    ) : (
      p
    ),
  )
}

export function SetupPage({ standalone = false }: { standalone?: boolean }) {
  const health = $api.useQuery('get', '/api/health', { params: { query: { fresh: '1' } } })
  const checks = health.data?.checks ?? []
  const left = checks.filter((c) => c.status === 'fail').length
  const body = (
    <div style={{ width: '100%', maxWidth: 1152 }}>
      {standalone ? (
        <Group gap={10} mb="lg">
          <Mark />
          <Text fw={600}>Video Agent</Text>
        </Group>
      ) : null}
      <PageHeader
        title="Setup"
        sub={
          health.isLoading
            ? 'Checking…'
            : health.data?.ready
              ? 'Everything needed is in place. People can make videos.'
              : `${left} ${left === 1 ? 'thing needs' : 'things need'} fixing before people can make videos.`
        }
      >
        <Button variant="default" loading={health.isFetching} onClick={() => void health.refetch()}>
          Check again
        </Button>
      </PageHeader>
      {health.isError ? (
        <Alert color="red" variant="light">
          The checks couldn't run. Is this the live production deploy?
        </Alert>
      ) : null}
      <div className="va-split">
        <Card>
          <Stack gap={0}>
            {checks.map((c, i) => (
              <div
                key={c.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 260fr) minmax(0, 452fr)',
                  gap: 16,
                  padding: '16px 0',
                  borderTop: i ? '1px solid var(--va-rule)' : 0,
                }}
              >
                <Group gap={10} wrap="nowrap" align="start">
                  <span
                    className="va-dot"
                    data-state={STATE[c.status]}
                    style={{ marginTop: 7 }}
                    aria-hidden
                  />
                  <div>
                    <Text fw={500}>{c.label}</Text>
                    <Text size="sm" c={c.status === 'fail' ? 'var(--va-negative)' : 'var(--va-faint)'}>
                      {WORD[c.status]}
                    </Text>
                  </div>
                </Group>
                <div>
                  <Text size="sm">{c.detail}</Text>
                  {c.fix && c.status !== 'ok' ? (
                    <Text size="sm" c="var(--va-muted)" mt={4}>
                      {linkify(c.fix)}
                    </Text>
                  ) : null}
                </div>
              </div>
            ))}
          </Stack>
        </Card>
        <div className="va-rail">
          <Card>
            <Text fw={600} mb="sm">
              Changing a setting
            </Text>
            <Stack gap={10}>
              <Text size="sm" c="var(--va-muted)">
                Settings are environment variables on the Netlify project: RUNNER_API_TOKEN,
                ALLOWED_EMAIL_DOMAINS, ADMIN_EMAILS and MAX_ACTIVE_RUNS. Change one, then redeploy.
              </Text>
              <Text size="sm" c="var(--va-muted)">
                Brand and product context live in context/ in the repo. Push a change and new videos use it.
              </Text>
              <Text size="sm" c="var(--va-muted)">
                Identity (who can sign up, invites, email confirmation) is under Project configuration,
                Identity.
              </Text>
            </Stack>
          </Card>
          <Card>
            <Text fw={600} mb="sm">
              From a terminal
            </Text>
            <Text size="sm" c="var(--va-muted)" mb="sm">
              The same checks, plus creating the project and setting the variables:
            </Text>
            <code
              style={{
                display: 'block',
                background: 'var(--va-raised)',
                padding: '8px 12px',
                borderRadius: 8,
                fontSize: 13,
              }}
            >
              npm run setup
            </code>
          </Card>
        </div>
      </div>
      {standalone ? (
        <Anchor href="/" size="sm" c="var(--va-muted)" mt="lg" display="inline-block">
          Back to sign in
        </Anchor>
      ) : null}
    </div>
  )
  return standalone ? (
    <div className="va-column" style={{ paddingTop: 48, paddingBottom: 96 }}>
      {body}
    </div>
  ) : (
    body
  )
}
