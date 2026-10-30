import { Alert, Button, Card, Code, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core'
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
  const revoke = $api.useMutation('delete', '/api/v1/keys/{id}', {
    onSuccess: () => void qc.invalidateQueries(),
  })
  const origin = window.location.origin
  const active = (keys.data ?? []).filter((k) => !k.revokedAt)
  const curl = (key: string) => `curl -X POST ${origin}/api/v1/videos \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"A 20-second launch video for our new feature","aspect":"16:9"}'

# Poll until "status" is "ready", then download:
curl -L -H "Authorization: Bearer ${key}" \\
  ${origin}/api/v1/videos/<id>/versions/1/video -o video.mp4`

  return (
    <>
      <div className="va-title-row">
        <div>
          <Title order={1}>API keys</Title>
          <div className="va-sub">
            {keys.isLoading
              ? 'Loading…'
              : `${active.length} active ${active.length === 1 ? 'key' : 'keys'}. Keys act as you, with your role.`}
          </div>
        </div>
      </div>

      <section className="va-setting">
        <div>
          <Text fw={500} size="lg">
            Your keys
          </Text>
          <Text size="sm" c="var(--va-muted)" mt={4}>
            For scripts and CI. Each key also gets a secret that signs the webhooks for videos it creates.
          </Text>
        </div>
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              create.mutate({ body: { name } })
            }}
          >
            <Group align="end" gap="sm">
              <TextInput
                label="New key name"
                placeholder="Release pipeline"
                required
                maxLength={80}
                value={name}
                onChange={(e) => {
                  setName(e.currentTarget.value)
                }}
                style={{ flex: 1 }}
              />
              <Button type="submit" loading={create.isPending}>
                Create key
              </Button>
            </Group>
          </form>
          {(keys.data ?? []).length === 0 && !keys.isLoading ? (
            <div className="va-empty" style={{ marginTop: 16 }}>
              No keys yet. Name one after the script that will use it.
            </div>
          ) : (
            <table className="va-table" style={{ marginTop: 16 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(keys.data ?? []).map((k) => (
                  <tr key={k.id} style={{ color: k.revokedAt ? 'var(--va-faint)' : undefined }}>
                    <td>{k.name}</td>
                    <td className="num">{relativeTime(k.createdAt)}</td>
                    <td className="num">{k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'Never'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {k.revokedAt ? (
                        'Revoked'
                      ) : (
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          onClick={() => {
                            modals.openConfirmModal({
                              title: `Revoke "${k.name}"?`,
                              children: <Text size="sm">Scripts using it stop working immediately.</Text>,
                              labels: { confirm: 'Revoke', cancel: 'Cancel' },
                              confirmProps: { color: 'red', variant: 'light' },
                              onConfirm: () => {
                                revoke.mutate({ params: { path: { id: k.id } } })
                              },
                            })
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>

      <section className="va-setting">
        <div>
          <Text fw={500} size="lg">
            Use it
          </Text>
          <Text size="sm" c="var(--va-muted)" mt={4}>
            Create, poll, download. Add <Code>webhookUrl</Code> to the request to get a signed{' '}
            <Code>video.ready</Code> event instead of polling.{' '}
            <a href="/api/docs" target="_blank" rel="noreferrer" style={{ color: 'var(--va-text)' }}>
              Full API reference
            </a>
          </Text>
        </div>
        <Card>
          <Code block style={{ background: 'var(--va-raised)', fontSize: 13 }}>
            {curl('nva_…')}
          </Code>
          <Text size="sm" c="var(--va-muted)" mt="md">
            Webhooks carry <Code>X-Video-Agent-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</Code>, an HMAC-SHA256
            of <Code>&lt;t&gt;.&lt;body&gt;</Code> with the key's webhook secret.
          </Text>
        </Card>
      </section>

      <Modal
        opened={created !== null}
        onClose={() => {
          setCreated(null)
        }}
        title={`Key "${created?.name ?? ''}" created`}
        size="lg"
        radius="lg"
      >
        {created ? (
          <Stack>
            <Alert color="yellow" variant="light">
              Copy these now. They're shown once.
            </Alert>
            <CopyField label="API key" value={created.key} />
            <CopyField label="Webhook signing secret" value={created.webhookSecret} />
            <Code block style={{ fontSize: 12 }}>
              {curl(created.key)}
            </Code>
          </Stack>
        ) : null}
      </Modal>
    </>
  )
}
