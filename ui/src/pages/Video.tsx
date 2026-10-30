import {
  Alert, Anchor, Badge, Button, Card, Center, Code, Grid, Group, Loader, Menu, Paper, Stack, Switch, Text, Textarea, TextInput, Timeline, Title,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { IconDots, IconDownload, IconExternalLink, IconWorld } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { $api, errorMessage, newIdempotencyKey, type Version, type Video } from '../api/client'
import { CopyField, Meta, StatusBadge, duration, fileUrl, inProgress, relativeTime } from '../components/bits'

const STAGES = ['queued', 'starting', 'running', 'finishing', 'ready'] as const
const STAGE_LABEL: Record<(typeof STAGES)[number], string> = {
  queued: 'Queued',
  starting: 'Starting a run',
  running: 'The agent is making it',
  finishing: 'Checking and saving the files',
  ready: 'Ready',
}

function stageIndex(v: Version): number {
  const s = v.stage ?? 'queued'
  if (s === 'cancelling' || s === 'unresolved') return 2
  const i = STAGES.indexOf(s as (typeof STAGES)[number])
  return i === -1 ? 4 : i
}

function useElapsed(since: string | null | undefined) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => { tick((n) => n + 1) }, 1000)
    return () => { clearInterval(t) }
  }, [])
  if (!since) return ''
  return duration((Date.now() - new Date(since).getTime()) / 1000)
}

function Progress({ video, v }: { video: Video; v: Version }) {
  const elapsed = useElapsed(v.timings?.queuedAt)
  const qc = useQueryClient()
  const cancel = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/cancel', {
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  })
  const [notify, setNotify] = useState(() => localStorage.getItem('notify') === '1' && Notification.permission === 'granted')
  return (
    <Paper withBorder p="lg" radius="md">
      <Stack>
        <Group justify="space-between">
          <Text fw={600}>Version {v.n} is in progress · {elapsed}</Text>
          <Button
            variant="default"
            size="xs"
            loading={cancel.isPending}
            disabled={v.stage === 'cancelling' || v.stage === 'unresolved'}
            onClick={() => { cancel.mutate({ params: { path: { id: video.id, n: v.n } } }) }}
          >
            {v.stage === 'cancelling' ? 'Cancelling…' : 'Cancel'}
          </Button>
        </Group>
        <Timeline active={stageIndex(v)} bulletSize={18} lineWidth={2}>
          {STAGES.map((s) => (
            <Timeline.Item key={s} title={STAGE_LABEL[s]} />
          ))}
        </Timeline>
        {v.latestStep ? (
          <Text size="sm" c="dimmed" lineClamp={3}>
            Agent activity: {v.latestStep}
          </Text>
        ) : null}
        <Text size="xs" c="dimmed">
          Status updates every minute. Most videos take a few minutes.
        </Text>
        {'Notification' in window ? (
          <Switch
            size="sm"
            label="Notify me when it's done (while this tab is open)"
            checked={notify}
            onChange={(e) => {
              const on = e.currentTarget.checked
              if (on && Notification.permission !== 'granted') {
                void Notification.requestPermission().then((p) => {
                  setNotify(p === 'granted')
                  localStorage.setItem('notify', p === 'granted' ? '1' : '0')
                })
              } else {
                setNotify(on)
                localStorage.setItem('notify', on ? '1' : '0')
              }
            }}
          />
        ) : null}
      </Stack>
    </Paper>
  )
}

function PublishPanel({ video, v, canPublish }: { video: Video; v: Version; canPublish: boolean }) {
  const qc = useQueryClient()
  const publish = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/publish', {
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  })
  const unpublish = $api.useMutation('delete', '/api/v1/videos/{id}/versions/{n}/publish', {
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  })
  const live = v.publications.find((p) => !p.unpublishedAt && p.urls)
  if (!live) {
    return canPublish ? (
      <Button leftSection={<IconWorld size={16} />} variant="light" loading={publish.isPending} onClick={() => { publish.mutate({ params: { path: { id: video.id, n: v.n } } }) }}>
        Publish version {v.n}
      </Button>
    ) : null
  }
  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap="xs">
            <IconWorld size={16} />
            <Text fw={600}>Version {v.n} is public</Text>
          </Group>
          {canPublish ? (
            <Button
              size="xs"
              variant="subtle"
              color="red"
              loading={unpublish.isPending}
              onClick={() => {
                modals.openConfirmModal({
                  title: 'Unpublish this version?',
                  children: <Text size="sm">The links stop working right away. Copies people already downloaded, and link previews already shown in Slack or social apps, can't be recalled.</Text>,
                  labels: { confirm: 'Unpublish', cancel: 'Keep it public' },
                  confirmProps: { color: 'red' },
                  onConfirm: () => { unpublish.mutate({ params: { path: { id: video.id, n: v.n } } }) },
                })
              }}
            >
              Unpublish
            </Button>
          ) : null}
        </Group>
        {live.urls ? (
          <>
            <CopyField label="Share page" value={live.urls.page} />
            <CopyField label="MP4" value={live.urls.mp4} />
            <CopyField label="GIF preview" value={live.urls.gif} />
            <CopyField label="Embed" value={live.embed ?? ''} />
          </>
        ) : null}
      </Stack>
    </Paper>
  )
}

export function VideoPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const me = $api.useQuery('get', '/api/v1/me')
  const video = $api.useQuery('get', '/api/v1/videos/{id}', { params: { path: { id } } }, {
    refetchInterval: (q) => (q.state.data && inProgress(q.state.data.status) ? 5000 : false),
  })
  const [selected, setSelected] = useState<number | null>(null)
  const [revision, setRevision] = useState('')
  const [revKey, setRevKey] = useState(newIdempotencyKey)
  const prevStatus = useRef<string | null>(null)

  const revise = $api.useMutation('post', '/api/v1/videos/{id}/versions', {
    onSuccess: () => {
      setRevision('')
      setRevKey(newIdempotencyKey())
      setSelected(null)
      void qc.invalidateQueries()
    },
    onError: (e) => notifications.show({ color: 'red', title: "Couldn't start the revision", message: errorMessage(e) }),
  })
  const retry = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/retry', {
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  })
  const rename = $api.useMutation('patch', '/api/v1/videos/{id}', { onSuccess: () => void qc.invalidateQueries() })
  const remove = $api.useMutation('delete', '/api/v1/videos/{id}', {
    onSuccess: () => {
      void qc.invalidateQueries()
      void navigate('/')
    },
  })

  const data = video.data
  useEffect(() => {
    if (!data) return
    const was = prevStatus.current
    prevStatus.current = data.status
    if (was && inProgress(was as Video['status']) && !inProgress(data.status)) {
      const msg = data.status === 'ready' ? `"${data.title}" is ready.` : `"${data.title}" ${data.status.replace('_', ' ')}.`
      if (localStorage.getItem('notify') === '1' && 'Notification' in window && Notification.permission === 'granted') new Notification(msg)
      notifications.show({ color: data.status === 'ready' ? 'green' : 'red', message: msg })
    }
  }, [data])

  if (video.isLoading) return <Center p="xl"><Loader /></Center>
  if (!data) return <Alert color="red">{errorMessage(video.error)}</Alert>

  const isAdmin = me.data?.role === 'admin'
  const isOwner = me.data?.id === data.owner.id
  const v = data.versions.find((x) => x.n === selected) ?? data.versions.find((x) => x.status === 'ready') ?? data.versions[0]
  const latest = data.versions[0]
  if (!v || !latest) return null
  const busy = data.versions.some((x) => inProgress(x.status))
  const canAct = (author: string) => isAdmin || isOwner || me.data?.id === author

  return (
    <Stack>
      <Group justify="space-between" align="start">
        <div>
          <Title order={2}>{data.title}</Title>
          <Text c="dimmed" size="sm">
            {data.owner.name ?? data.owner.email} · {relativeTime(data.createdAt)} · {data.aspect}
          </Text>
        </div>
        <Group gap="xs">
          <StatusBadge status={data.status} />
          {isAdmin || isOwner ? (
            <Menu position="bottom-end">
              <Menu.Target>
                <Button variant="default" size="xs" px={8} aria-label="More actions"><IconDots size={16} /></Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  onClick={() => {
                    let t = data.title
                    modals.openConfirmModal({
                      title: 'Rename',
                      children: <TextInput defaultValue={data.title} maxLength={120} onChange={(e) => { t = e.currentTarget.value }} data-autofocus />,
                      labels: { confirm: 'Save', cancel: 'Cancel' },
                      onConfirm: () => { rename.mutate({ params: { path: { id } }, body: { title: t } }) },
                    })
                  }}
                >
                  Rename
                </Menu.Item>
                <Menu.Item
                  color="red"
                  onClick={() => {
                    modals.openConfirmModal({
                      title: 'Delete this video?',
                      children: <Text size="sm">Every version, file and public link is removed. This can't be undone.</Text>,
                      labels: { confirm: 'Delete', cancel: 'Cancel' },
                      confirmProps: { color: 'red' },
                      onConfirm: () => { remove.mutate({ params: { path: { id } } }) },
                    })
                  }}
                >
                  Delete
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          ) : null}
        </Group>
      </Group>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack>
            {inProgress(latest.status) ? <Progress video={data} v={latest} /> : null}
            {v.status === 'ready' ? (
              <video
                key={`${data.id}-${v.n}`}
                controls
                playsInline
                poster={fileUrl(data.id, v.n, 'poster')}
                src={fileUrl(data.id, v.n, 'video')}
                style={{ width: '100%', maxHeight: '70vh', background: '#000', borderRadius: 12 }}
              >
                <track kind="captions" src={fileUrl(data.id, v.n, 'captions')} srcLang="en" label="Captions" default />
              </video>
            ) : null}
            {['failed', 'cancelled', 'timed_out'].includes(v.status) ? (
              <Alert color={v.status === 'failed' ? 'red' : 'orange'} title={`Version ${v.n} ${v.status === 'timed_out' ? 'timed out' : v.status}`}>
                <Stack gap="xs">
                  <Text size="sm">
                    {v.error?.message ?? (v.status === 'cancelled' ? 'It was cancelled.' : 'The run did not finish.')}
                    {v.status === 'timed_out' && v.targetDurationSec === null ? ' Try again with a shorter target length.' : ''}
                  </Text>
                  {v.n === latest.n && canAct(v.authorId) ? (
                    <Group>
                      <Button size="xs" loading={retry.isPending} disabled={busy} onClick={() => { retry.mutate({ params: { path: { id, n: v.n } } }) }}>
                        Try again
                      </Button>
                    </Group>
                  ) : null}
                </Stack>
              </Alert>
            ) : null}
            {v.status === 'ready' ? (
              <Group gap="xs">
                {(['video', 'poster', 'gif', 'captions'] as const).map((f) => (
                  <Button key={f} component="a" href={fileUrl(data.id, v.n, f, true)} size="xs" variant="default" leftSection={<IconDownload size={14} />}>
                    {{ video: 'MP4', poster: 'Poster', gif: 'GIF', captions: 'Captions' }[f]}
                  </Button>
                ))}
              </Group>
            ) : null}
            {v.status === 'ready' ? <PublishPanel video={data} v={v} canPublish={isAdmin || isOwner} /> : null}

            <Card withBorder radius="md" padding="md">
              <Stack gap="xs">
                <Text fw={600}>Revise</Text>
                <Textarea
                  autosize
                  minRows={2}
                  placeholder={busy ? 'Wait for the version in progress to finish.' : `Change something about version ${v.status === 'ready' ? v.n : '…'}, e.g. "make the end card orange"`}
                  value={revision}
                  disabled={busy || v.status !== 'ready'}
                  onChange={(e) => { setRevision(e.currentTarget.value) }}
                />
                <Group>
                  <Button
                    disabled={busy || v.status !== 'ready' || revision.trim().length < 3}
                    loading={revise.isPending}
                    onClick={() => { revise.mutate({ params: { path: { id }, header: { 'idempotency-key': revKey } }, body: { prompt: revision, fromVersion: v.n } }) }}
                  >
                    Make version {data.versions.length + 1}
                  </Button>
                  {v.status !== 'ready' && !busy ? <Text size="sm" c="dimmed">Select a ready version to revise it.</Text> : null}
                </Group>
              </Stack>
            </Card>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack>
            <Card withBorder radius="md" padding="md">
              <Text fw={600} mb="xs">Versions</Text>
              <Stack gap="xs">
                {data.versions.map((x) => (
                  <Paper
                    key={x.n}
                    withBorder
                    p="xs"
                    radius="sm"
                    onClick={() => { setSelected(x.n) }}
                    style={{ cursor: 'pointer', borderColor: x.n === v.n ? 'var(--mantine-primary-color-filled)' : undefined }}
                  >
                    <Group justify="space-between" gap="xs">
                      <Text size="sm" fw={600}>v{x.n}</Text>
                      <Group gap={4}>
                        {x.publications.some((p) => !p.unpublishedAt) ? <Badge size="xs" variant="outline">Public</Badge> : null}
                        <StatusBadge status={x.status} />
                      </Group>
                    </Group>
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} {...(x.n === v.n ? {} : { lineClamp: 2 })}>
                      {x.prompt}
                    </Text>
                    <Text size="xs" c="dimmed">{relativeTime(x.createdAt)}{x.parentN ? ` · from v${x.parentN}` : ''}</Text>
                  </Paper>
                ))}
              </Stack>
            </Card>
            {v.output ? (
              <Card withBorder radius="md" padding="md">
                <Text fw={600} mb="xs">What the agent said</Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{v.output.summary || '—'}</Text>
              </Card>
            ) : null}
            <Card withBorder radius="md" padding="md">
              <Text fw={600} mb="xs">Details (v{v.n})</Text>
              <Stack gap={4}>
                {v.output ? <Meta label="Format">{v.output.width}×{v.output.height}, {duration(v.output.durationSec)}, {(v.output.bytes / 1e6).toFixed(1)} MB</Meta> : null}
                <Meta label="Length asked">{v.targetDurationSec ? `${v.targetDurationSec}s` : 'Auto'}</Meta>
                {v.agent ? <Meta label="Agent">{[v.agent.agent, v.agent.model, v.agent.effort].filter(Boolean).join(' · ')}</Meta> : null}
                {v.agent?.deployId ? <Meta label="Deploy"><Code>{v.agent.deployId.slice(0, 12)}</Code></Meta> : null}
                <Meta label="Credits">{v.usage?.totalCreditsCost !== undefined ? v.usage.totalCreditsCost.toFixed(1) : 'unknown'}</Meta>
                {v.timings?.startedAt ? <Meta label="Started">{new Date(v.timings.startedAt).toLocaleString()}</Meta> : null}
                {v.timings?.endedAt ? <Meta label="Finished">{new Date(v.timings.endedAt).toLocaleString()}</Meta> : null}
                <Meta label="Attempts">{v.attempts}</Meta>
                {v.links.netlifyRun ? (
                  <Anchor href={v.links.netlifyRun} target="_blank" size="sm">
                    <Group gap={4}>View run in Netlify <IconExternalLink size={14} /></Group>
                  </Anchor>
                ) : null}
              </Stack>
            </Card>
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  )
}
