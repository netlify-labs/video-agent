// Connected accounts (docs/plans/2026-11-04-publish-destinations.md §4, §6.2): your YouTube channel, to publish
// videos there. Shown only when YouTube is set up on this video agent. Disconnecting revokes the grant; videos already
// published stay on YouTube.
import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useEffect } from 'react'
import { $api } from '../api/client'
import { confirmDanger, useAfterWrite } from './bits'

const MESSAGES: Record<string, string> = {
  connected: 'YouTube connected.',
  denied: 'You didn’t allow access, so YouTube isn’t connected.',
  expired: 'That took too long or came from another browser. Try connecting again.',
  scope: 'Google didn’t grant access to YouTube. Try again and allow it.',
  no_refresh_token:
    'Google didn’t give lasting access. Remove Video Agent under your Google account’s third-party access, then connect again.',
  google: 'Google had a problem. Try again in a minute.',
}

export function ConnectedAccounts() {
  const afterWrite = useAfterWrite()
  const q = $api.useQuery('get', '/api/v1/me/connections')
  const del = $api.useMutation('delete', '/api/v1/me/connections/{id}', afterWrite)
  // Back from Google: say how it went once, then tidy the URL.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('youtube')
    if (!r) return
    notifications.show({
      color: r === 'connected' ? 'green' : 'red',
      message: MESSAGES[r] ?? MESSAGES.google,
    })
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`)
  }, [])
  const yt = q.data?.youtube
  if (!yt?.available) return null
  // One kind of connection today (YouTube).
  const conn = q.data?.items[0]
  return (
    <section style={{ marginTop: 32 }} id="connected-accounts">
      <Card>
        <Text fw={600} mb={4}>
          Connected accounts
        </Text>
        <Text size="sm" c="var(--va-muted)" mb="sm">
          Connect your YouTube channel to publish videos there (Publish to → YouTube). Videos go up unlisted
          unless you choose otherwise.
        </Text>
        {conn ? (
          <Group justify="space-between" data-testid="youtube-connection">
            <Stack gap={2}>
              <Group gap={8}>
                <Text size="sm" fw={500}>
                  YouTube · {conn.account}
                </Text>
                {conn.status === 'reconnect' ? (
                  <Badge size="sm" color="orange" variant="light">
                    Needs reconnecting
                  </Badge>
                ) : null}
              </Group>
              <Text size="xs" c="var(--va-faint)">
                Connected {new Date(conn.connectedAt).toLocaleDateString()}
              </Text>
            </Stack>
            <Group gap="xs">
              {conn.status === 'reconnect' ? (
                <Button size="xs" component="a" href={yt.connectUrl}>
                  Reconnect
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="subtle"
                color="red"
                loading={del.isPending}
                onClick={() => {
                  confirmDanger({
                    title: 'Disconnect YouTube?',
                    body: 'Videos you already published stay on YouTube. To take one down later, connect again first.',
                    confirm: 'Disconnect',
                    onConfirm: () => {
                      del.mutate({ params: { path: { id: conn.id } } })
                    },
                  })
                }}
              >
                Disconnect
              </Button>
            </Group>
          </Group>
        ) : (
          <Button size="xs" component="a" href={yt.connectUrl}>
            Connect YouTube
          </Button>
        )}
      </Card>
    </section>
  )
}
