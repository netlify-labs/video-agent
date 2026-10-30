import { Alert, Button, Code, Group, Modal, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { $api, errorMessage } from '../api/client'
import { CopyField, relativeTime } from '../components/bits'

export function KeysPage() {
  const qc = useQueryClient()
  const keys = $api.useQuery('get', '/api/v1/keys')
  const [name, setName] = useState('')
  const [created, setCreated] = useState<{ key: string; webhookSecret: string; name: string } | null>(null)
  const create = $api.useMutation('post', '/api/v1/keys', {
    onSuccess: (k) => {
      setCreated(k)
      setName('')
      void qc.invalidateQueries()
    },
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  })
  const revoke = $api.useMutation('delete', '/api/v1/keys/{id}', { onSuccess: () => void qc.invalidateQueries() })
  const origin = window.location.origin
  const curl = created
    ? `curl -X POST ${origin}/api/v1/videos \\
  -H "Authorization: Bearer ${created.key}" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"A 20-second launch video for our new feature","aspect":"16:9"}'

# Then poll until "status" is "ready" and download:
curl -L -H "Authorization: Bearer ${created.key}" ${origin}/api/v1/videos/<id>/versions/1/video -o video.mp4`
    : ''

  return (
    <Stack maw={860}>
      <Title order={2}>API keys</Title>
      <Text c="dimmed" size="sm">
        Keys let scripts and CI make videos as you. Anything the web app does, the API can do: see the <a href="/api/docs" target="_blank">API docs</a>.
      </Text>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate({ body: { name } })
        }}
      >
        <Group align="end">
          <TextInput label="Name" placeholder="e.g. release pipeline" required maxLength={80} value={name} onChange={(e) => { setName(e.currentTarget.value) }} style={{ flex: 1 }} />
          <Button type="submit" loading={create.isPending}>Create key</Button>
        </Group>
      </form>
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr><Table.Th>Name</Table.Th><Table.Th>Created</Table.Th><Table.Th>Last used</Table.Th><Table.Th /></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(keys.data ?? []).map((k) => (
            <Table.Tr key={k.id} opacity={k.revokedAt ? 0.5 : 1}>
              <Table.Td>{k.name}</Table.Td>
              <Table.Td>{relativeTime(k.createdAt)}</Table.Td>
              <Table.Td>{k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'never'}</Table.Td>
              <Table.Td align="right">
                {k.revokedAt ? (
                  <Text size="sm" c="dimmed">revoked</Text>
                ) : (
                  <Button size="xs" variant="subtle" color="red" onClick={() => {
                    modals.openConfirmModal({
                      title: `Revoke "${k.name}"?`,
                      children: <Text size="sm">Scripts using it stop working immediately.</Text>,
                      labels: { confirm: 'Revoke', cancel: 'Cancel' },
                      confirmProps: { color: 'red' },
                      onConfirm: () => { revoke.mutate({ params: { path: { id: k.id } } }) },
                    })
                  }}>Revoke</Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={created !== null} onClose={() => { setCreated(null) }} title={`Key "${created?.name ?? ''}" created`} size="lg">
        {created ? (
          <Stack>
            <Alert color="yellow">Copy these now. They won't be shown again.</Alert>
            <CopyField label="API key" value={created.key} />
            <CopyField label="Webhook signing secret" value={created.webhookSecret} />
            <Text size="sm" fw={500}>Try it</Text>
            <Code block>{curl}</Code>
            <Text size="sm" c="dimmed">
              Add <Code>"webhookUrl": "https://…"</Code> to get a signed <Code>video.ready</Code> / <Code>video.failed</Code> event instead of polling.
              The <Code>X-Video-Agent-Signature</Code> header is <Code>t=&lt;unix&gt;,v1=HMAC-SHA256(secret, "&lt;t&gt;.&lt;body&gt;")</Code>.
            </Text>
          </Stack>
        ) : null}
      </Modal>
    </Stack>
  )
}
