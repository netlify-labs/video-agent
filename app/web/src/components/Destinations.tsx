// Publish destinations in the video page (docs/plans/2026-11-04-publish-destinations.md §6.2): "Publish to" lists
// every destination besides the share page; each opens a dialog (where it goes, its options form, instructions); and
// "Published to" lists where a version is published, with status, link, message, warnings, Reveal, Remove and Try
// again. Copy is generic: words that are specific to a destination (its noun, its instructions label and hint, its
// progress messages, its secret's label) come from the destination itself.
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  CopyButton,
  Group,
  Loader,
  Menu,
  Modal,
  PasswordInput,
  Radio,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconChevronDown, IconLockOpen, IconSend, IconTrash } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { $api, errorMessage, newIdempotencyKey, type Version, type Video } from '../api/client'
import { confirmDanger, useAfterWrite } from './bits'

type Destinations = NonNullable<ReturnType<typeof useDestinationList>['data']>['items']
type Destination = Destinations[number]
type Entry = Version['destinations'][number]

interface OptionSpec {
  type: 'string' | 'boolean'
  title?: string
  description?: string
  minLength?: number
  maxLength?: number
  enum?: string[]
  default?: string | boolean
  /** A secret: masked here, kept encrypted by the server. */
  format?: 'password'
  /** A boolean option's name: this one shows only while that one is on. */
  showIf?: string
}
interface OptionsSchema {
  type: 'object'
  properties: Record<string, OptionSpec>
  required?: string[]
}

const ACTIVE: Entry['status'][] = ['queued', 'running', 'waiting', 'removing']

/** True while any of a video's destination publications is still working (the page keeps polling). */
export const destinationsActive = (v: Video | undefined) =>
  !!v?.versions.some((x) => x.destinations.some((d) => d.kind !== 'share_page' && ACTIVE.includes(d.status)))

function useDestinationList() {
  return $api.useQuery('get', '/api/v1/destinations', {}, { staleTime: 30_000 })
}

/** "Publish to ▾": every destination besides the share page (which keeps its own button). */
export function PublishToMenu({ video, v }: { video: Video; v: Version }) {
  const list = useDestinationList()
  const [open, setOpen] = useState<Destination | null>(null)
  const others = (list.data?.items ?? []).filter((d) => d.kind !== 'share_page')
  if (!others.length || v.status !== 'ready') return null
  return (
    <>
      <Menu position="bottom-end">
        <Menu.Target>
          <Button
            variant="default"
            rightSection={<IconChevronDown size={14} />}
            leftSection={<IconSend size={14} />}
          >
            Publish to
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {others.map((d) => (
            <Menu.Item
              key={d.id}
              disabled={!d.ready}
              onClick={() => {
                setOpen(d)
              }}
            >
              <Stack gap={0}>
                <Text size="sm">{d.name}</Text>
                {d.reason ? (
                  <Text size="xs" c="var(--va-faint)">
                    {d.reason}
                  </Text>
                ) : null}
              </Stack>
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      {open ? (
        <DestinationDialog
          destination={open}
          video={video}
          v={v}
          onClose={() => {
            setOpen(null)
          }}
        />
      ) : null}
    </>
  )
}

const utf8 = (s: string) => new TextEncoder().encode(s).length

function creditsText(v: Version): string {
  const lines = (
    v.credits as { title?: string; creator?: string | null; license?: string; url?: string | null }[]
  ).map((c) => [c.title, c.creator ? `by ${c.creator}` : null, c.license, c.url].filter(Boolean).join(' · '))
  return lines.length ? `Credits:\n${lines.join('\n')}` : ''
}

/** The dialog for one destination: where it goes, its options form, instructions, transcript. */
export function DestinationDialog({
  destination,
  video,
  v,
  onClose,
}: {
  destination: Destination
  video: Video
  v: Version
  onClose: () => void
}) {
  const afterWrite = useAfterWrite()
  const [key] = useState(newIdempotencyKey)
  const caps = destination.capabilities
  const schema = (destination.optionsSchema ?? null) as OptionsSchema | null
  const targets = $api.useQuery(
    'get',
    '/api/v1/destinations/{id}/targets',
    { params: { path: { id: destination.id }, query: { videoId: video.id } } },
    { enabled: caps.targets },
  )
  const youtube = destination.kind === 'youtube'
  const live = v.publications.find((p) => !p.unpublishedAt && p.urls)
  const initial = useMemo(() => {
    const out: Record<string, string | boolean> = {}
    for (const [k, spec] of Object.entries(schema?.properties ?? {}))
      if (spec.default !== undefined) out[k] = spec.default
    if (youtube) {
      out.title = (v.output?.title ?? video.title).slice(0, 100)
      out.description = [v.output?.summary ?? '', live?.urls?.page ?? '']
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 4000)
    }
    return out
  }, [schema, youtube, v, video, live])
  const [values, setValues] = useState<Record<string, string | boolean>>(initial)
  const [where, setWhere] = useState<string>('new')
  const [instructions, setInstructions] = useState('')
  const [transcript, setTranscript] = useState(false)
  const credits = youtube ? creditsText(v) : ''
  const descBytes = youtube
    ? utf8(`${String(values.description ?? '')}${credits ? `\n\n${credits}` : ''}`)
    : 0
  const publish = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/destinations', {
    onSuccess: (r) => {
      afterWrite.onSuccess()
      notifications.show({ message: `Publishing to ${r.destination.name}…` })
      onClose()
    },
    onError: afterWrite.onError,
  })
  const props = Object.entries(schema?.properties ?? {})
  // An option behind a switch shows (and counts) only while the switch is on; the server drops it otherwise.
  const shown = props.filter(([, spec]) => spec.showIf === undefined || values[spec.showIf] === true)
  const missing = (schema?.required ?? []).filter(
    (k) => shown.some(([name]) => name === k) && (values[k] === undefined || values[k] === ''),
  )
  const tooShort = shown.some(([k, spec]) => {
    const x = values[k]
    return spec.minLength !== undefined && typeof x === 'string' && x !== '' && x.length < spec.minLength
  })
  const tooLong =
    youtube &&
    (descBytes > 5000 ||
      String(values.title ?? '').length > 100 ||
      /[<>]/.test(`${String(values.title ?? '')}${String(values.description ?? '')}`))
  const noun = caps.targetNoun
  const list = targets.data?.targets ?? []
  return (
    <Modal opened onClose={onClose} title={`Publish v${v.n} to ${destination.name}`} centered size="lg">
      <Stack gap="md">
        {video.private ? (
          <Alert color="yellow" icon={<IconLockOpen size={16} />} data-testid="publish-makes-visible">
            This video is private. Publishing it here also makes it visible to everyone on the team.
          </Alert>
        ) : null}
        {caps.targets ? (
          <Stack gap={6}>
            <Text fw={600} size="sm">
              Where
            </Text>
            {targets.isLoading ? <Loader size="sm" /> : null}
            <Radio.Group value={where} onChange={setWhere}>
              <Stack gap={8}>
                <Radio value="new" label={noun ? `New ${noun}` : 'New'} />
                {list.length ? (
                  <Text size="xs" c="var(--va-faint)">
                    {noun ? `Your ${noun}s` : 'Existing'}
                  </Text>
                ) : null}
                {list.map((t) => (
                  <Radio
                    key={t.id}
                    value={t.id}
                    label={
                      <Stack gap={0}>
                        <Text size="sm">{t.name}</Text>
                        {t.description ? (
                          <Text size="xs" c="var(--va-faint)">
                            {t.description}
                          </Text>
                        ) : null}
                        {t.url ? (
                          <Anchor href={t.url} target="_blank" size="xs">
                            {t.url}
                          </Anchor>
                        ) : null}
                      </Stack>
                    }
                  />
                ))}
              </Stack>
            </Radio.Group>
            {targets.data?.error ? (
              <Text size="xs" c="var(--va-faint)">
                Couldn't load the existing ones ({targets.data.error}); you can still publish to a new one.
              </Text>
            ) : null}
          </Stack>
        ) : null}
        {shown.map(([k, spec]) => {
          const label = spec.title ?? k
          if (spec.type === 'boolean')
            return (
              <Switch
                key={k}
                label={label}
                description={spec.description}
                checked={values[k] === true}
                onChange={(e) => {
                  setValues({ ...values, [k]: e.currentTarget.checked })
                }}
              />
            )
          if (spec.enum)
            return (
              <Select
                key={k}
                label={label}
                description={spec.description}
                data={spec.enum}
                value={typeof values[k] === 'string' ? values[k] : null}
                allowDeselect={false}
                onChange={(x) => {
                  if (x !== null) setValues({ ...values, [k]: x })
                }}
              />
            )
          if (youtube && k === 'description')
            return (
              <Stack key={k} gap={4}>
                <Textarea
                  label={label}
                  autosize
                  minRows={4}
                  value={String(values[k] ?? '')}
                  onChange={(e) => {
                    setValues({ ...values, [k]: e.currentTarget.value })
                  }}
                />
                {credits ? (
                  <Text size="xs" c="var(--va-faint)" style={{ whiteSpace: 'pre-wrap' }}>
                    {credits}
                  </Text>
                ) : null}
                <Text size="xs" c={descBytes > 5000 ? 'red' : 'var(--va-faint)'}>
                  {descBytes} / 5000 bytes, credits included. No &lt; or &gt;.
                </Text>
              </Stack>
            )
          if (spec.format === 'password') {
            const x = String(values[k] ?? '')
            return (
              <PasswordInput
                key={k}
                label={label}
                description={spec.description}
                withAsterisk={schema?.required?.includes(k) ?? false}
                maxLength={spec.maxLength}
                autoComplete="new-password"
                value={x}
                error={
                  spec.minLength !== undefined && x !== '' && x.length < spec.minLength
                    ? `At least ${spec.minLength} characters.`
                    : undefined
                }
                onChange={(e) => {
                  setValues({ ...values, [k]: e.currentTarget.value })
                }}
              />
            )
          }
          return (
            <TextInput
              key={k}
              label={label}
              description={spec.description}
              withAsterisk={schema?.required?.includes(k) ?? false}
              maxLength={spec.maxLength}
              value={String(values[k] ?? '')}
              onChange={(e) => {
                setValues({ ...values, [k]: e.currentTarget.value })
              }}
            />
          )
        })}
        {caps.instructions ? (
          <Textarea
            label={caps.instructionsLabel ?? 'Instructions'}
            description={caps.instructionsHint ?? undefined}
            autosize
            minRows={5}
            maxLength={4000}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.currentTarget.value)
            }}
          />
        ) : null}
        {v.links.transcript ? (
          <Switch
            label="Include the transcript"
            checked={transcript}
            onChange={(e) => {
              setTranscript(e.currentTarget.checked)
            }}
          />
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={publish.isPending}
            disabled={missing.length > 0 || tooLong || tooShort}
            onClick={() => {
              const target = where === 'new' ? null : (list.find((t) => t.id === where) ?? null)
              publish.mutate({
                params: { path: { id: video.id, n: v.n }, header: { 'idempotency-key': key } },
                body: {
                  destination: destination.id,
                  options: values,
                  target,
                  instructions: instructions.trim() ? instructions.trim() : null,
                  includeTranscript: transcript,
                  ...(video.private ? { makeVisible: true } : {}),
                },
              })
            }}
          >
            Publish
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

const STATUS_WORD: Record<Entry['status'], string> = {
  queued: 'Queued',
  running: 'Publishing',
  waiting: 'Processing',
  live: 'Live',
  removing: 'Removing',
  removed: 'Removed',
  failed: 'Failed',
}

/** Where this version is published, besides the share page (which has its own card). */
export function PublishedTo({ v, canPublish }: { v: Version; canPublish: boolean }) {
  const rows = v.destinations.filter((d) => d.kind !== 'share_page' && d.status !== 'removed')
  const afterWrite = useAfterWrite()
  const remove = $api.useMutation('delete', '/api/v1/destination-publications/{id}', afterWrite)
  const retry = $api.useMutation('post', '/api/v1/destination-publications/{id}/retry', afterWrite)
  if (!rows.length) return null
  return (
    <Card>
      <Text fw={600} mb="sm">
        Published to
      </Text>
      <Stack gap="sm">
        {rows.map((d) => (
          <Stack key={d.id} gap={4} data-testid="published-to-row">
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Group gap={8} style={{ minWidth: 0 }}>
                <Text size="sm" fw={500}>
                  {d.destination.name}
                  {d.target ? ` · ${d.target.name}` : ''}
                </Text>
                <Badge
                  size="sm"
                  variant="light"
                  style={{ flexShrink: 0 }}
                  color={d.status === 'live' ? 'green' : d.status === 'failed' ? 'red' : 'gray'}
                  leftSection={ACTIVE.includes(d.status) ? <Loader size={10} color="currentColor" /> : null}
                >
                  {STATUS_WORD[d.status]}
                </Badge>
              </Group>
              {canPublish && d.desired === 'published' ? (
                <Button
                  size="compact-xs"
                  variant="light"
                  color="red"
                  style={{ flexShrink: 0 }}
                  leftSection={<IconTrash size={14} />}
                  loading={remove.isPending}
                  onClick={() => {
                    confirmDanger({
                      title: `Remove it from ${d.destination.name}?`,
                      body: 'It is taken down there. Copies people already saved there can’t be recalled.',
                      confirm: 'Remove',
                      cancel: 'Keep it',
                      onConfirm: () => {
                        remove.mutate({ params: { path: { id: d.id } } })
                      },
                    })
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </Group>
            {d.status === 'failed' && d.error ? (
              <Text size="xs" c="red">
                {d.error.message}
              </Text>
            ) : d.status === 'live' && d.url ? (
              // Live: the address itself is the link (no progress text, no separate "Open").
              <Anchor
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
                size="sm"
                truncate="end"
                title={d.url}
              >
                {d.url.replace(/^https:\/\//, '').replace(/\/$/, '')}
              </Anchor>
            ) : ACTIVE.includes(d.status) ? (
              <Text size="xs" c="var(--va-faint)">
                {d.message ?? 'Processing'}
              </Text>
            ) : d.message ? (
              <Text size="xs" c="var(--va-faint)">
                {d.message}
              </Text>
            ) : null}
            {d.warnings.map((w) => (
              <Text key={w} size="xs" c="orange">
                {w}
              </Text>
            ))}
            {canPublish && (d.hasSecret || d.status === 'failed') ? (
              <Group gap="xs">
                {d.hasSecret ? <RevealSecret id={d.id} label={d.secretLabel ?? 'Secret'} /> : null}
                {d.status === 'failed' ? (
                  <Button
                    size="compact-xs"
                    variant="light"
                    loading={retry.isPending}
                    onClick={() => {
                      retry.mutate({ params: { path: { id: d.id } } })
                    }}
                  >
                    Try again
                  </Button>
                ) : null}
              </Group>
            ) : null}
          </Stack>
        ))}
      </Stack>
    </Card>
  )
}

/** Reveal {label}: shows a one-time secret once, with a copy button; the server never shows it again. */
function RevealSecret({ id, label }: { id: string; label: string }) {
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null)
  const afterWrite = useAfterWrite()
  const reveal = $api.useMutation('post', '/api/v1/destination-publications/{id}/secret', {
    onSuccess: (r) => {
      setShown(r)
    },
    onError: (e) => {
      notifications.show({ color: 'red', message: errorMessage(e) })
    },
  })
  return (
    <>
      <Button
        size="compact-xs"
        variant="light"
        loading={reveal.isPending}
        onClick={() => {
          reveal.mutate({ params: { path: { id } } })
        }}
      >
        Reveal {label.toLowerCase()}
      </Button>
      {shown ? (
        <Modal
          opened
          centered
          title={shown.label}
          onClose={() => {
            setShown(null)
            afterWrite.onSuccess()
          }}
        >
          <Stack gap="sm">
            <Group wrap="nowrap">
              <TextInput readOnly value={shown.value} style={{ flex: 1 }} aria-label={shown.label} />
              <CopyButton value={shown.value}>
                {({ copied, copy }) => <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>}
              </CopyButton>
            </Group>
            <Text size="xs" c="var(--va-faint)">
              You won't see this again: copy it somewhere safe now.
            </Text>
          </Stack>
        </Modal>
      ) : null}
    </>
  )
}
