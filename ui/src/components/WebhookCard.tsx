// Personal (API keys page) or team (Admin page) webhook: set the URL, see the signing secret once, test, remove.
import { Alert, Button, Card, Group, Stack, Text, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { $api, errorMessage } from '../api/client'
import { CopyField } from './bits'

export function WebhookCard({ scope }: { scope: 'personal' | 'team' }) {
  const path = scope === 'personal' ? '/api/v1/me/webhook' : '/api/v1/admin/team-webhook'
  const qc = useQueryClient()
  const current = $api.useQuery('get', path)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  useEffect(() => {
    if (current.data?.url) setUrl(current.data.url)
  }, [current.data?.url])
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorMessage(e) })
  const refresh = () => void qc.invalidateQueries()
  const save = $api.useMutation('put', path, {
    onSuccess: (r) => {
      setSecret(r?.secret ?? null)
      refresh()
    },
    onError,
  })
  const remove = $api.useMutation('delete', path, {
    onSuccess: () => {
      setUrl('')
      setSecret(null)
      refresh()
    },
    onError,
  })
  const test = $api.useMutation('post', `${path}/test`, {
    onSuccess: (r) =>
      notifications.show({
        color: r.ok ? 'teal' : 'red',
        message: r.ok ? `Delivered (${r.result})` : r.result,
      }),
    onError,
  })
  const has = Boolean(current.data)
  return (
    <Card>
      <Stack gap="sm">
        <div>
          <Text fw={600}>{scope === 'personal' ? 'Your webhook' : 'Team webhook'}</Text>
          <Text size="sm" c="var(--va-muted)">
            {scope === 'personal'
              ? 'Signed events for videos you own: ready, failed, new comments, approvals.'
              : 'Signed events for every video, including private ones, for example to post into Slack.'}
          </Text>
        </div>
        <Group align="flex-end" gap="sm" wrap="nowrap">
          <TextInput
            label="URL"
            placeholder="https://hooks.example.com/video-agent"
            value={url}
            onChange={(e) => {
              setUrl(e.currentTarget.value)
            }}
            style={{ flex: 1 }}
          />
          <Button
            loading={save.isPending}
            disabled={!url}
            onClick={() => {
              save.mutate({ body: { url } })
            }}
          >
            Save
          </Button>
        </Group>
        {secret ? (
          <Stack gap="xs">
            <Alert color="yellow" variant="light">
              Copy the signing secret now. It's shown once.
            </Alert>
            <CopyField label="Signing secret" value={secret} />
          </Stack>
        ) : null}
        {has ? (
          <Group gap="xs">
            <Button variant="default" size="xs" loading={test.isPending} onClick={() => test.mutate({})}>
              Send a test event
            </Button>
            <Button variant="default" size="xs" onClick={() => save.mutate({ body: { url, rotate: true } })}>
              New secret
            </Button>
            <Button variant="subtle" color="red" size="xs" onClick={() => remove.mutate({})}>
              Remove
            </Button>
          </Group>
        ) : null}
      </Stack>
    </Card>
  )
}
