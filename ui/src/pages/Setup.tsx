import { Alert, Anchor, Badge, Button, Card, Center, Group, Loader, Stack, Text, Title } from '@mantine/core'
import { $api } from '../api/client'

const COLOR = { ok: 'green', fail: 'red', warn: 'yellow', unknown: 'gray' } as const
const LABEL = { ok: 'OK', fail: 'Needs fixing', warn: 'Recommended', unknown: 'Not checked' } as const

function linkify(text: string) {
  const parts = text.split(/(https:\/\/\S+)/g)
  return parts.map((p, i) => (p.startsWith('https://') ? <Anchor key={i} href={p} target="_blank">{p}</Anchor> : p))
}

export function SetupPage({ standalone = false }: { standalone?: boolean }) {
  const health = $api.useQuery('get', '/api/health', { params: { query: { fresh: '1' } } })
  const body = (
    <Stack maw={820} w="100%">
      <Title order={2}>Setup</Title>
      <Text c="dimmed" size="sm">
        Everything this video agent needs before people can make videos. Fix each item, redeploy if it asks you to, then check again.
      </Text>
      {health.isLoading ? <Center p="xl"><Loader /></Center> : null}
      {health.data?.ready ? <Alert color="green" title="Ready">Everything needed is in place.</Alert> : null}
      {(health.data?.checks ?? []).map((c) => (
        <Card key={c.id} withBorder radius="md" padding="md">
          <Group justify="space-between" align="start" wrap="nowrap">
            <Stack gap={4}>
              <Text fw={600}>{c.label}</Text>
              <Text size="sm">{c.detail}</Text>
              {c.fix && c.status !== 'ok' ? <Text size="sm" c="dimmed">{linkify(c.fix)}</Text> : null}
            </Stack>
            <Badge color={COLOR[c.status]} variant="light">{LABEL[c.status]}</Badge>
          </Group>
        </Card>
      ))}
      <Group>
        <Button variant="default" loading={health.isFetching} onClick={() => void health.refetch()}>Check again</Button>
        {standalone ? <Anchor href="/">Back to sign in</Anchor> : null}
      </Group>
    </Stack>
  )
  return standalone ? <Center p="md" mih="100vh">{body}</Center> : body
}
