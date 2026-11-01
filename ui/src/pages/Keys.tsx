import { Alert, Button, Card, Code, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { $api } from '../api/client'
import { CopyField, confirmDanger, relativeTime, showError } from '../components/bits'
import { WebhookCard } from '../components/WebhookCard'

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
    onError: showError,
  })
  const revoke = $api.useMutation('delete', '/api/v1/keys/{id}', {
    onSuccess: () => void qc.invalidateQueries(),
  })
  const config = $api.useQuery('get', '/api/v1/config')
  const oauth = config.data?.mcpOAuth === true
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
                            confirmDanger({
                              title: `Revoke "${k.name}"?`,
                              body: 'Scripts using it stop working immediately.',
                              confirm: 'Revoke',
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

      {oauth ? <ConnectedApps mcpUrl={`${origin}/mcp`} /> : null}

      <section style={{ marginTop: 32 }}>
        <WebhookCard scope="personal" />
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

/** MCP OAuth is on: clients can sign in with Netlify instead of using a key; the apps you connected, with Revoke. */
function ConnectedApps({ mcpUrl }: { mcpUrl: string }) {
  const qc = useQueryClient()
  const grants = $api.useQuery('get', '/api/v1/oauth/grants')
  const revoke = $api.useMutation('delete', '/api/v1/oauth/grants/{id}', {
    onSuccess: () => void qc.invalidateQueries(),
    onError: showError,
  })
  const list = grants.data ?? []
  return (
    <section className="va-setting">
      <div>
        <Text fw={500} size="lg">
          Connected apps
        </Text>
        <Text size="sm" c="var(--va-muted)" mt={4}>
          MCP clients can connect to <Code>{mcpUrl}</Code> with <b>Sign in with Netlify</b> (OAuth) or an API
          key. Apps you connect act as you, with your role.
        </Text>
      </div>
      <Card>
        {list.length === 0 && !grants.isLoading ? (
          <div className="va-empty">
            No connected apps. Add {mcpUrl} as a connector in Claude or ChatGPT and sign in with Netlify.
          </div>
        ) : (
          <table className="va-table" aria-label="Connected apps">
            <thead>
              <tr>
                <th>App</th>
                <th>Connected</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((g) => (
                <tr key={g.id}>
                  <td>{g.clientName}</td>
                  <td className="num">{relativeTime(g.createdAt)}</td>
                  <td className="num">{g.lastUsedAt ? relativeTime(g.lastUsedAt) : 'Never'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => {
                        confirmDanger({
                          title: `Disconnect "${g.clientName}"?`,
                          body: 'It stops working immediately. You can connect it again by signing in.',
                          confirm: 'Revoke',
                          onConfirm: () => {
                            revoke.mutate({ params: { path: { id: g.id } } })
                          },
                        })
                      }}
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  )
}
