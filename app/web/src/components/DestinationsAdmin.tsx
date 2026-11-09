// Admin → Destinations (docs/plans/2026-11-04-publish-destinations.md §3.6, §6.2): HTTP destinations with their live
// and failed counts; add one (name, URL, options form, contact sharing); the signing secret shown once; rotate, test,
// turn off, remove from everywhere, delete.
import {
  Anchor,
  Badge,
  Button,
  Card,
  CopyButton,
  Group,
  Modal,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useState } from 'react'
import { $api, errorMessage } from '../api/client'
import { confirmDanger, useAfterWrite } from './bits'

function SecretOnce({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Modal opened centered onClose={onClose} title="Signing secret">
      <Stack gap="sm">
        <Text size="sm">
          The destination checks every request with this secret (x-video-agent-signature). It's shown only
          now.
        </Text>
        <Group wrap="nowrap">
          <TextInput readOnly value={secret} style={{ flex: 1 }} aria-label="Signing secret" />
          <CopyButton value={secret}>
            {({ copied, copy }) => <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>}
          </CopyButton>
        </Group>
      </Stack>
    </Modal>
  )
}

/** YouTube on or off, with what setting it up takes (publish destinations §4). */
export function YouTubeAdminCard() {
  const afterWrite = useAfterWrite()
  const settings = $api.useQuery('get', '/api/v1/admin/settings')
  const save = $api.useMutation('patch', '/api/v1/admin/settings', afterWrite)
  const s = settings.data
  return (
    <Card>
      <Text fw={600} mb="xs">
        YouTube
      </Text>
      <Switch
        label="People can publish to their YouTube channel"
        description={
          s?.youtubeConfigured
            ? 'Each person connects their own channel under API keys → Connected accounts.'
            : 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see the checklist).'
        }
        checked={s?.youtubeEnabled ?? false}
        disabled={!s?.youtubeConfigured}
        onChange={(e) => {
          save.mutate({ body: { youtubeEnabled: e.currentTarget.checked } })
        }}
      />
      <Stack gap={2} mt="sm">
        <Text size="xs" c="var(--va-faint)">
          Setup: a Google Cloud project with the YouTube Data API v3 · an OAuth web client whose redirect URI
          is {window.location.origin}/auth/google/callback · scope youtube.force-ssl · GOOGLE_CLIENT_ID and
          GOOGLE_CLIENT_SECRET in this site's environment · move the consent screen out of Testing (in
          Testing, connections end after 7 days) · Google's verification before more than 100 people connect.
        </Text>
        <Anchor href="/docs/destinations#youtube" size="xs">
          Setup guide
        </Anchor>
      </Stack>
    </Card>
  )
}

export function DestinationsAdminCard() {
  const afterWrite = useAfterWrite()
  const list = $api.useQuery('get', '/api/v1/admin/destinations')
  const [adding, setAdding] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const rotate = $api.useMutation('post', '/api/v1/admin/destinations/{id}/rotate', {
    onSuccess: (r) => {
      afterWrite.onSuccess()
      setSecret(r.secret)
    },
    onError: afterWrite.onError,
  })
  const test = $api.useMutation('post', '/api/v1/admin/destinations/{id}/test', {
    onSuccess: (r) => {
      afterWrite.onSuccess()
      const caps = Object.keys(r.capabilities ?? {}).filter((k) => (r.capabilities ?? {})[k] !== false)
      notifications.show({
        color: r.ok ? 'green' : 'red',
        message: r.ok
          ? `It answered${caps.length ? `; it supports ${caps.join(', ')}` : ''}.`
          : `The test failed: ${r.error ?? `HTTP ${r.status}`}`,
      })
    },
    onError: afterWrite.onError,
  })
  const update = $api.useMutation('patch', '/api/v1/admin/destinations/{id}', afterWrite)
  const removeAll = $api.useMutation('post', '/api/v1/admin/destinations/{id}/remove-all', afterWrite)
  const del = $api.useMutation('delete', '/api/v1/admin/destinations/{id}', afterWrite)
  const items = list.data?.items ?? []
  return (
    <Card>
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Destinations</Text>
        <Button
          size="xs"
          variant="light"
          onClick={() => {
            setAdding(true)
          }}
        >
          Add HTTP destination
        </Button>
      </Group>
      <Text size="sm" c="var(--va-muted)" mb="sm">
        Where people can publish a ready version besides the share page. An HTTP destination is any HTTPS
        endpoint that speaks the{' '}
        <Anchor href="/docs/destinations" size="sm">
          destination contract
        </Anchor>
        .
      </Text>
      {items.length === 0 ? <div className="va-empty">No HTTP destinations yet.</div> : null}
      <Stack gap="sm">
        {items.map((d) => (
          <Stack key={d.id} gap={4} data-testid="admin-destination">
            <Group justify="space-between" wrap="nowrap">
              <Group gap={8}>
                <Text fw={500} size="sm">
                  {d.name}
                </Text>
                {d.enabled ? null : (
                  <Badge size="sm" variant="light" color="gray">
                    Off
                  </Badge>
                )}
              </Group>
              <Text size="xs" c="var(--va-faint)">
                {d.live} live · {d.failed} failed
              </Text>
            </Group>
            <Text size="xs" c="var(--va-faint)">
              {new URL(d.url).host}
            </Text>
            <Group gap="xs">
              <Button
                size="compact-xs"
                variant="light"
                loading={test.isPending}
                onClick={() => test.mutate({ params: { path: { id: d.id } } })}
              >
                Send a test
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => {
                  confirmDanger({
                    title: 'Rotate the signing secret?',
                    body: 'Requests are signed with the new secret at once; update the receiver right after.',
                    confirm: 'Rotate',
                    onConfirm: () => rotate.mutate({ params: { path: { id: d.id } } }),
                  })
                }}
              >
                Rotate secret
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() =>
                  update.mutate({ params: { path: { id: d.id } }, body: { enabled: !d.enabled } })
                }
              >
                {d.enabled ? 'Turn off' : 'Turn on'}
              </Button>
              {d.live + d.failed > 0 ? (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  onClick={() => {
                    confirmDanger({
                      title: `Remove ${d.live + d.failed} publication(s) from ${d.name}?`,
                      body: 'Each one is taken down there.',
                      confirm: 'Remove everywhere',
                      onConfirm: () => removeAll.mutate({ params: { path: { id: d.id } } }),
                    })
                  }}
                >
                  Remove from everywhere
                </Button>
              ) : (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  onClick={() => {
                    confirmDanger({
                      title: `Delete ${d.name}?`,
                      body: 'People can no longer publish there.',
                      confirm: 'Delete',
                      onConfirm: () => del.mutate({ params: { path: { id: d.id } } }),
                    })
                  }}
                >
                  Delete
                </Button>
              )}
            </Group>
          </Stack>
        ))}
      </Stack>
      {adding ? (
        <AddDestination
          onClose={() => {
            setAdding(false)
          }}
          onCreated={(s) => {
            setAdding(false)
            setSecret(s)
          }}
        />
      ) : null}
      {secret ? (
        <SecretOnce
          secret={secret}
          onClose={() => {
            setSecret(null)
          }}
        />
      ) : null}
    </Card>
  )
}

function AddDestination({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (secret: string) => void
}) {
  const afterWrite = useAfterWrite()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [schema, setSchema] = useState('')
  const [contact, setContact] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const create = $api.useMutation('post', '/api/v1/admin/destinations', {
    onSuccess: (r) => {
      afterWrite.onSuccess()
      onCreated(r.secret)
    },
    onError: (e) => {
      setErr(errorMessage(e))
    },
  })
  let parsed: unknown = undefined
  let parseError: string | null = null
  if (schema.trim()) {
    try {
      parsed = JSON.parse(schema) as unknown
    } catch {
      parseError = 'Not valid JSON.'
    }
  }
  return (
    <Modal opened centered onClose={onClose} title="Add an HTTP destination" size="lg">
      <Stack gap="sm">
        <TextInput
          label="Name"
          placeholder="Our demo sites"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <TextInput
          label="URL"
          placeholder="https://receiver.example.com/video-agent"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
        />
        <Textarea
          label="Options form (optional)"
          description='JSON: { "type": "object", "properties": { "name": { "type": "string", "title": "Site name" } } }. Strings and switches only.'
          autosize
          minRows={3}
          value={schema}
          error={parseError}
          onChange={(e) => setSchema(e.currentTarget.value)}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        />
        <Switch
          label="Share the publisher's name and email"
          description="Off: the destination gets only the publisher's id."
          checked={contact}
          onChange={(e) => setContact(e.currentTarget.checked)}
        />
        {err ? (
          <Text size="sm" c="red">
            {err}
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!name.trim() || !url.trim() || parseError !== null}
            onClick={() => {
              setErr(null)
              create.mutate({
                body: {
                  name,
                  url,
                  sharePublisherContact: contact,
                  ...(parsed !== undefined ? { optionsSchema: parsed } : {}),
                },
              })
            }}
          >
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
