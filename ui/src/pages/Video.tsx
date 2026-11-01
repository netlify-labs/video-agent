import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Card,
  CopyButton,
  Group,
  Menu,
  SegmentedControl,
  Skeleton,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { MediaChips, type Media } from '../components/MediaPicker'
import { PlanPanel } from '../components/PlanPanel'
import { CommentsCard, ReviewPlayer, VerdictBar, clockTime, type Pin } from '../components/Review'
import { CompositionPreview } from '../components/CompositionPreview'
import { IconDots, IconDownload, IconExternalLink, IconLock, IconLockOpen } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { $api, errorMessage, newIdempotencyKey, videoInit, type Version, type Video } from '../api/client'
import {
  CopyField,
  Meta,
  StageTrack,
  Status,
  VersionImage,
  confirmDanger,
  credits,
  duration,
  fileUrl,
  inProgress,
  relativeTime,
  showError,
} from '../components/bits'

const STAGE_WORDS: Record<string, string> = {
  queued: 'Waiting for a free slot',
  starting: 'Starting an agent run',
  running: 'The agent is writing and checking the composition',
  cancelling: 'Stopping the run',
  unresolved: 'Checking whether the run started (an admin can resolve this)',
  finishing: 'Verifying and saving the files',
}

function useTicker() {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => {
      set((n) => n + 1)
    }, 1000)
    return () => {
      clearInterval(t)
    }
  }, [])
}

function clock(since: string | null | undefined): string {
  return since ? clockTime(Math.max(0, (Date.now() - new Date(since).getTime()) / 1000)) : '0:00'
}

/** Whether the person asked for a browser notification when a run ends, and still allows them. */
function notifyOn(): boolean {
  try {
    return (
      localStorage.getItem('notify') === '1' &&
      'Notification' in window &&
      Notification.permission === 'granted'
    )
  } catch {
    return false
  }
}

function updatedAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 5 ? 'updated just now' : s < 60 ? `updated ${s} s ago` : `updated ${relativeTime(iso)}`
}

const useProgress = (video: Video, v: Version) =>
  $api.useQuery(
    'get',
    '/api/v1/videos/{id}/progress',
    { params: { path: { id: video.id } } },
    { refetchInterval: 3000, refetchIntervalInBackground: false, enabled: inProgress(v.status) },
  )

/** Live narration (plan v2 §6 A1): polls /progress every 3 s while the tab is visible and the run is going. */
function Narration({ video, v }: { video: Video; v: Version }) {
  const progress = useProgress(video, v)
  const p = progress.data?.versionN === v.n ? progress.data : null
  // The run's own milestones (checkpoints) read better than the SDK's step; render-job reports Rendering N%.
  const cp = p?.checkpoint
  const step = cp?.message ?? p?.step ?? v.latestStep
  const rendering =
    cp?.renderPercent != null && cp.renderPercent < 100 && v.status === 'running' ? cp.renderPercent : null
  if (!step && p?.steps == null && rendering === null) return null
  const counts = [
    p?.steps != null ? `${p.steps} step${p.steps === 1 ? '' : 's'}` : null,
    p?.credits != null ? `${credits(p.credits)} credits so far` : null,
  ].filter(Boolean)
  return (
    <Stack gap={2} data-testid="narration">
      {rendering !== null ? (
        <Text size="sm" c="var(--va-muted)" className="num">
          Rendering {rendering}%
        </Text>
      ) : step ? (
        <Text size="sm" c="var(--va-muted)" lineClamp={2}>
          Working: {step}
        </Text>
      ) : null}
      <Text size="xs" c="var(--va-faint)" className="num">
        {[...counts, p?.observedAt ? updatedAgo(p.observedAt) : null].filter(Boolean).join(' · ')}
        {p?.stale ? " · couldn't reach the run, showing the last update" : ''}
      </Text>
    </Stack>
  )
}

function Progress({ video, v, canCancel }: { video: Video; v: Version; canCancel: boolean }) {
  useTicker()
  const qc = useQueryClient()
  // The agent's latest composition snapshot, when its checkpoints send one (plan v2 §6 A2). Same query as Narration.
  const progress = useProgress(video, v)
  const snapshot =
    progress.data?.versionN === v.n && progress.data.checkpoint?.hasBundle ? progress.data.checkpoint : null
  const cancel = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/cancel', {
    onSuccess: () => void qc.invalidateQueries(),
    onError: showError,
  })
  const [notify, setNotify] = useState(notifyOn)
  return (
    <Card p={0} style={{ overflow: 'hidden' }}>
      {snapshot ? (
        <div style={{ padding: 12, paddingBottom: 0 }} data-testid="live-snapshot">
          <CompositionPreview
            key={snapshot.seq}
            videoId={video.id}
            versionN={v.n}
            dimensions={video.dimensions}
            live
          />
        </div>
      ) : null}
      <div
        style={{
          aspectRatio: snapshot ? undefined : '16 / 9',
          background: 'var(--va-raised)',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
        }}
      >
        <Stack gap="md" w="min(520px, 100%)">
          <Group justify="space-between" align="baseline">
            <Text fw={600} size="lg">
              {v.status === 'queued' ? `Version ${v.n} is queued` : `Making version ${v.n}`}
            </Text>
            <Text size="xl" fw={500} className="num" aria-label="Elapsed">
              {clock(v.timings?.queuedAt)}
            </Text>
          </Group>
          <StageTrack version={v} />
          <Text size="sm" c="var(--va-muted)">
            {STAGE_WORDS[v.stage ?? 'queued'] ?? 'Working'}
          </Text>
          <Narration video={video} v={v} />
          <Group justify="space-between" mt="xs">
            {'Notification' in window ? (
              <Switch
                size="sm"
                label="Notify me when it's done"
                checked={notify}
                onChange={(e) => {
                  const on = e.currentTarget.checked
                  const save = (x: boolean) => {
                    setNotify(x)
                    try {
                      localStorage.setItem('notify', x ? '1' : '0')
                    } catch {
                      // private mode
                    }
                  }
                  if (on && Notification.permission !== 'granted')
                    void Notification.requestPermission().then((p) => {
                      save(p === 'granted')
                    })
                  else save(on)
                }}
              />
            ) : (
              <span />
            )}
            {canCancel ? (
              <Button
                variant="default"
                size="xs"
                loading={cancel.isPending}
                disabled={v.stage === 'cancelling' || v.stage === 'unresolved'}
                onClick={() => {
                  cancel.mutate({ params: { path: { id: video.id, n: v.n } } })
                }}
              >
                {v.stage === 'cancelling' ? 'Stopping…' : 'Cancel'}
              </Button>
            ) : null}
          </Group>
        </Stack>
      </div>
    </Card>
  )
}

function Filmstrip({
  video,
  selected,
  onSelect,
}: {
  video: Video
  selected: number
  onSelect: (n: number) => void
}) {
  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Versions</Text>
        <Text size="sm" c="var(--va-faint)" className="num">
          {video.versions.length}
        </Text>
      </Group>
      <Stack gap={4}>
        {video.versions.map((x) => {
          const pub = x.publications.some((p) => !p.unpublishedAt)
          return (
            <button
              key={x.n}
              type="button"
              className="va-version"
              aria-pressed={x.n === selected}
              onClick={() => {
                onSelect(x.n)
              }}
            >
              <div className="va-poster">
                {x.status === 'ready' ? (
                  <VersionImage videoId={video.id} v={x} file="poster" sizes="112px" />
                ) : (
                  <StageTrack version={x} />
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <Group justify="space-between" gap={6} wrap="nowrap">
                  <Text size="sm" fw={500}>
                    v{x.n}
                    {x.parentN ? (
                      <span style={{ color: 'var(--va-faint)', fontWeight: 400 }}> from v{x.parentN}</span>
                    ) : null}
                  </Text>
                  <Status status={x.status} size="xs" />
                </Group>
                <Text size="sm" c="var(--va-muted)" lineClamp={2}>
                  {x.prompt}
                </Text>
                <Text size="xs" c="var(--va-faint)">
                  {relativeTime(x.createdAt)}
                  {pub ? ' · Public' : ''}
                </Text>
              </div>
            </button>
          )
        })}
      </Stack>
    </Card>
  )
}

function PublicLink({ video, v, canPublish }: { video: Video; v: Version; canPublish: boolean }) {
  const qc = useQueryClient()
  const unpublish = $api.useMutation('delete', '/api/v1/videos/{id}/versions/{n}/publish', {
    onSuccess: () => void qc.invalidateQueries(),
    onError: showError,
  })
  const live = v.publications.find((p) => !p.unpublishedAt && p.urls)
  if (!live?.urls) return null
  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Public link for v{v.n}</Text>
        <Anchor href={live.urls.page} target="_blank" size="sm" c="var(--va-muted)">
          <Group gap={4}>
            Open <IconExternalLink size={14} />
          </Group>
        </Anchor>
      </Group>
      <Stack gap="sm">
        <CopyField label="Share page" value={live.urls.page} />
        <CopyField label="MP4" value={live.urls.mp4} />
        <CopyField label="GIF" value={live.urls.gif} />
        <CopyField label="Embed" value={live.embed ?? ''} />
        {canPublish ? (
          <Group justify="space-between" mt={4}>
            <Text size="xs" c="var(--va-faint)">
              Anyone with the link can watch it.
            </Text>
            <Button
              variant="subtle"
              color="red"
              size="xs"
              loading={unpublish.isPending}
              onClick={() => {
                confirmDanger({
                  title: 'Unpublish this version?',
                  body: "The links stop working right away. Copies people already downloaded, and link previews already shown in Slack or social apps, can't be recalled.",
                  confirm: 'Unpublish',
                  cancel: 'Keep it public',
                  onConfirm: () => {
                    unpublish.mutate({ params: { path: { id: video.id, n: v.n } } })
                  },
                })
              }}
            >
              Unpublish
            </Button>
          </Group>
        ) : null}
      </Stack>
    </Card>
  )
}

export function VideoPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const me = $api.useQuery('get', '/api/v1/me')
  const canCreate = me.data?.role === 'admin' || me.data?.role === 'creator'
  const config = $api.useQuery('get', '/api/v1/config')
  const canPlan = canCreate && config.data?.planningAvailable === true
  const [planningRevision, setPlanningRevision] = useState(false)
  const video = $api.useQuery('get', '/api/v1/videos/{id}', videoInit(id), {
    refetchInterval: (q) => (q.state.data && inProgress(q.state.data.status) ? 5000 : false),
  })
  const [selected, setSelected] = useState<number | null>(null)
  const [revision, setRevision] = useState('')
  const [revMedia, setRevMedia] = useState<Media[]>([])
  const [revKey, setRevKey] = useState(newIdempotencyKey)
  const revMediaBody = revMedia.length ? { mediaIds: revMedia.map((m) => m.id) } : {}
  const prevStatus = useRef<string | null>(null)
  const player = useRef<HTMLVideoElement>(null)
  const [picking, setPicking] = useState(false)
  const [pending, setPending] = useState<Pin | null>(null)
  const [view, setView] = useState<'video' | 'composition'>('video')
  const select = (n: number) => {
    setSelected(n)
    setPicking(false)
    setPending(null)
  }

  const revise = $api.useMutation('post', '/api/v1/videos/{id}/versions', {
    onSuccess: () => {
      setRevision('')
      setRevMedia([])
      setRevKey(newIdempotencyKey())
      setSelected(null)
      void qc.invalidateQueries()
    },
    onError: showError,
  })
  const afterWrite = { onSuccess: () => void qc.invalidateQueries(), onError: showError }
  const retry = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/retry', afterWrite)
  const publish = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/publish', afterWrite)
  const rename = $api.useMutation('patch', '/api/v1/videos/{id}', afterWrite)
  const remove = $api.useMutation('delete', '/api/v1/videos/{id}', {
    onSuccess: () => {
      void qc.invalidateQueries()
      void navigate('/')
    },
    onError: showError,
  })

  const data = video.data
  useEffect(() => {
    if (!data) return
    const was = prevStatus.current
    prevStatus.current = data.status
    if (was && inProgress(was as Video['status']) && !inProgress(data.status)) {
      const msg = data.status === 'ready' ? `"${data.title}" is ready.` : `"${data.title}" didn't finish.`
      try {
        if (notifyOn()) new Notification(msg)
      } catch {
        // notifications unavailable
      }
      notifications.show({ color: data.status === 'ready' ? 'teal' : 'red', message: msg })
    }
  }, [data])

  if (video.isLoading) {
    return (
      <>
        <div className="va-title-row">
          <div>
            <Skeleton height={28} width={320} />
            <Skeleton height={14} width={420} mt={10} />
          </div>
        </div>
        <div className="va-split">
          <Card p={0}>
            <div style={{ aspectRatio: '16 / 9', background: 'var(--va-raised)' }} />
          </Card>
          <Card>
            <Skeleton height={16} width={120} />
            <Skeleton height={64} mt="md" />
            <Skeleton height={64} mt="sm" />
          </Card>
        </div>
      </>
    )
  }
  if (!data) {
    return (
      <Alert color="red" variant="light" title="Couldn't load this video">
        <Group justify="space-between">
          <Text size="sm">{errorMessage(video.error)}</Text>
          <Button variant="default" size="xs" onClick={() => void video.refetch()}>
            Retry
          </Button>
        </Group>
      </Alert>
    )
  }

  const isAdmin = me.data?.role === 'admin'
  const isOwner = me.data?.id === data.owner.id
  const latest = data.versions[0]
  const v =
    data.versions.find((x) => x.n === selected) ?? data.versions.find((x) => x.status === 'ready') ?? latest
  if (!v || !latest) return null
  const busy = data.versions.some((x) => inProgress(x.status))
  const canPublish = isAdmin || isOwner
  const canAct = (author: string) => isAdmin || isOwner || me.data?.id === author
  // Retry spends credits, so it also needs Creator; cancel doesn't.
  const canRetry = (author: string) => canCreate && canAct(author)
  // Reviewers and up comment and approve; viewers watch.
  const canReview = me.data !== undefined && me.data.role !== 'viewer'
  const live = v.publications.find((p) => !p.unpublishedAt && p.urls)
  const showProgress = inProgress(latest.status) && (selected === null || selected === latest.n)
  const makeRevision = (planId?: string | null) => {
    revise.mutate({
      params: { path: { id }, header: { 'idempotency-key': revKey } },
      body: { prompt: revision, fromVersion: v.n, ...(planId ? { planId } : {}), ...revMediaBody },
    })
  }

  const sub = inProgress(latest.status)
    ? `Making v${latest.n}${latest.parentN ? ` from v${latest.parentN}` : ''}. ${data.versions.some((x) => x.status === 'ready') ? 'Earlier versions are below.' : 'Usually ready in 3 to 8 minutes.'}`
    : v.status === 'ready' && v.output
      ? `v${v.n} · ${duration(v.output.durationSec)} · ${v.output.width}×${v.output.height} · ${data.owner.name ?? data.owner.email?.split('@')[0] ?? ''} · ${relativeTime(v.createdAt)}`
      : `v${v.n} ${v.status === 'timed_out' ? 'timed out' : v.status}${v.error ? `: ${v.error.message}` : ''}`

  return (
    <>
      <Anchor component={Link} to="/" size="sm" c="var(--va-muted)">
        Library
      </Anchor>
      <div className="va-title-row" style={{ marginTop: 4 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Title order={1} style={{ overflowWrap: 'anywhere' }}>
            {data.title}
          </Title>
          <div className="va-sub num">{sub}</div>
        </div>
        <Group gap="sm">
          {v.status === 'ready' && canCreate ? (
            <Tooltip
              label="This version can't be edited in the browser. Ask for a revision instead."
              disabled={v.editable}
            >
              <Button
                variant="default"
                disabled={!v.editable}
                onClick={() => {
                  void navigate(`/videos/${data.id}/edit/${v.n}`)
                }}
              >
                Edit
              </Button>
            </Tooltip>
          ) : null}
          {v.status === 'ready' ? (
            <Button
              component="a"
              href={fileUrl(data.id, v.n, 'video', true)}
              variant="default"
              leftSection={<IconDownload size={16} />}
            >
              MP4
            </Button>
          ) : null}
          {v.status === 'ready' && canPublish && !live ? (
            <Button
              loading={publish.isPending}
              onClick={() => {
                publish.mutate({ params: { path: { id: data.id, n: v.n } } })
              }}
            >
              Publish v{v.n}
            </Button>
          ) : live?.urls ? (
            <CopyButton value={live.urls.page}>
              {({ copied, copy }) => (
                <Button onClick={copy}>{copied ? 'Link copied' : 'Copy public link'}</Button>
              )}
            </CopyButton>
          ) : null}
          {canPublish ? (
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size={36} radius="xl" aria-label="More actions">
                  <IconDots size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {v.status === 'ready'
                  ? (['poster', 'gif', 'captions'] as const).map((f) => (
                      <Menu.Item
                        key={f}
                        component="a"
                        href={fileUrl(data.id, v.n, f, true)}
                        leftSection={<IconDownload size={14} />}
                      >
                        Download {f === 'gif' ? 'GIF preview' : f}
                      </Menu.Item>
                    ))
                  : null}
                <Menu.Item
                  onClick={() => {
                    let t = data.title
                    modals.openConfirmModal({
                      title: 'Rename',
                      children: (
                        <TextInput
                          defaultValue={data.title}
                          maxLength={120}
                          onChange={(e) => {
                            t = e.currentTarget.value
                          }}
                          data-autofocus
                        />
                      ),
                      labels: { confirm: 'Save', cancel: 'Cancel' },
                      onConfirm: () => {
                        rename.mutate({ params: { path: { id } }, body: { title: t } })
                      },
                    })
                  }}
                >
                  Rename
                </Menu.Item>
                <Menu.Item
                  leftSection={data.private ? <IconLockOpen size={14} /> : <IconLock size={14} />}
                  onClick={() => {
                    rename.mutate({ params: { path: { id } }, body: { private: !data.private } })
                  }}
                >
                  {data.private ? 'Make visible to the team' : 'Make private'}
                </Menu.Item>
                <Menu.Item
                  color="red"
                  onClick={() => {
                    confirmDanger({
                      title: 'Delete this video?',
                      body: "Every version, file and public link is removed. This can't be undone.",
                      confirm: 'Delete',
                      onConfirm: () => {
                        remove.mutate({ params: { path: { id } } })
                      },
                    })
                  }}
                >
                  Delete
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          ) : null}
        </Group>
      </div>

      <div className="va-split">
        <div className="va-rail">
          {showProgress ? (
            <Progress video={data} v={latest} canCancel={canAct(latest.authorId)} />
          ) : v.status === 'ready' ? (
            <Stack gap="xs">
              <SegmentedControl
                size="xs"
                w="fit-content"
                value={view}
                onChange={(x) => {
                  setView(x)
                }}
                data={[
                  { value: 'video', label: 'Video' },
                  { value: 'composition', label: 'Live composition' },
                ]}
              />
              {view === 'composition' ? (
                <CompositionPreview
                  key={`${data.id}-${v.n}`}
                  videoId={data.id}
                  versionN={v.n}
                  dimensions={data.dimensions}
                />
              ) : null}
              <div hidden={view !== 'video'}>
                <ReviewPlayer
                  video={data}
                  v={v}
                  player={player}
                  picking={picking}
                  pending={pending}
                  onPick={(x, y) => {
                    if (pending) setPending({ ...pending, x, y })
                    setPicking(false)
                  }}
                />
              </div>
              <VerdictBar video={data} v={v} canReview={canReview && me.data.id !== v.authorId} />
            </Stack>
          ) : (
            <Card p={0} style={{ overflow: 'hidden' }}>
              <div
                style={{
                  aspectRatio: '16 / 9',
                  background: 'var(--va-raised)',
                  display: 'grid',
                  placeItems: 'center',
                  padding: 24,
                }}
              >
                <Stack gap="sm" maw={480}>
                  <Text fw={600} size="lg">
                    Version {v.n}{' '}
                    {v.status === 'timed_out'
                      ? 'timed out'
                      : v.status === 'cancelled'
                        ? 'was cancelled'
                        : "didn't finish"}
                  </Text>
                  <Text size="sm" c="var(--va-muted)">
                    {v.error?.message ??
                      (v.status === 'cancelled'
                        ? 'Someone stopped it before it finished.'
                        : 'The run ended without a video.')}
                    {v.status === 'timed_out' && v.targetDurationSec === null
                      ? ' A shorter target length usually fixes this.'
                      : ''}
                  </Text>
                  {v.mode === 'render_unchanged' && v.editedFromN && canCreate ? (
                    // Retrying renders the same edit again: going back to the editor is what helps.
                    <Group mt="xs">
                      <Button
                        onClick={() => {
                          void navigate(`/videos/${data.id}/edit/${v.editedFromN ?? 1}`)
                        }}
                      >
                        Edit v{v.editedFromN} again
                      </Button>
                    </Group>
                  ) : v.n === latest.n && canRetry(v.authorId) ? (
                    <Group mt="xs">
                      <Button
                        loading={retry.isPending}
                        disabled={busy}
                        onClick={() => {
                          retry.mutate({ params: { path: { id, n: v.n } } })
                        }}
                      >
                        Try again
                      </Button>
                    </Group>
                  ) : null}
                </Stack>
              </div>
            </Card>
          )}

          <CommentsCard
            video={data}
            v={v}
            player={player}
            canComment={canReview}
            canIncorporate={canCreate && canPublish}
            busy={busy}
            picking={picking}
            setPicking={setPicking}
            pending={pending}
            setPending={setPending}
          />

          {canCreate ? (
            <Card>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (canPlan) {
                    setPlanningRevision(true)
                    return
                  }
                  makeRevision()
                }}
              >
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Text fw={600}>Revise</Text>
                    <Text size="sm" c="var(--va-faint)">
                      {busy
                        ? 'Wait for the version in progress'
                        : v.status === 'ready'
                          ? `Starts from v${v.n}`
                          : 'Pick a ready version'}
                    </Text>
                  </Group>
                  <Textarea
                    aria-label="What should change?"
                    autosize
                    minRows={2}
                    placeholder='What should change? For example: "make the end card say Start free today"'
                    value={revision}
                    disabled={busy || v.status !== 'ready'}
                    onChange={(e) => {
                      setRevision(e.currentTarget.value)
                    }}
                  />
                  <MediaChips
                    value={revMedia}
                    onChange={setRevMedia}
                    disabled={busy || v.status !== 'ready' || planningRevision}
                    label="Add media"
                  />
                  <Group gap={0} className={canPlan ? 'va-split-button' : undefined}>
                    <Button
                      type="submit"
                      disabled={
                        busy || v.status !== 'ready' || revision.trim().length < 3 || planningRevision
                      }
                      loading={revise.isPending && !canPlan}
                    >
                      {canPlan ? 'Plan it first' : `Make v${data.versions.length + 1}`}
                    </Button>
                    {canPlan ? (
                      <Button
                        variant="default"
                        disabled={busy || v.status !== 'ready' || revision.trim().length < 3}
                        loading={revise.isPending && !planningRevision}
                        onClick={() => {
                          makeRevision()
                        }}
                      >
                        Make v{data.versions.length + 1} now
                      </Button>
                    ) : null}
                  </Group>
                </Stack>
              </form>
            </Card>
          ) : null}
          {planningRevision ? (
            <PlanPanel
              key={`${id}-${v.n}`}
              prompt={revision}
              revisionOf={{ videoId: id, version: v.n }}
              mediaIds={revMedia.map((m) => m.id)}
              creating={revise.isPending}
              onClose={() => {
                setPlanningRevision(false)
              }}
              onCreate={(planId) => {
                setPlanningRevision(false)
                makeRevision(planId)
              }}
            />
          ) : null}

          <Card>
            <Text fw={600} mb={8}>
              {v.output?.summary ? 'What the agent made' : 'The request'}
            </Text>
            <Text size="sm" c="var(--va-muted)" style={{ whiteSpace: 'pre-wrap' }}>
              {v.output?.summary ?? v.prompt}
            </Text>
          </Card>
        </div>

        <div className="va-rail">
          <Filmstrip video={data} selected={v.n} onSelect={select} />
          <PublicLink video={data} v={v} canPublish={canPublish} />
          <Card>
            <Text fw={600} mb="sm">
              Details for v{v.n}
            </Text>
            <Stack gap={8}>
              <Meta label="Prompt">{v.prompt.length > 80 ? `${v.prompt.slice(0, 80)}…` : v.prompt}</Meta>
              <Meta label="Length">
                {v.output ? duration(v.output.durationSec) : '—'}{' '}
                {v.targetDurationSec ? `(asked ${v.targetDurationSec} s)` : '(auto)'}
              </Meta>
              <Meta label="File">{v.output ? `${(v.output.bytes / 1e6).toFixed(2)} MB` : '—'}</Meta>
              <Meta label="Credits">{credits(v.usage?.totalCreditsCost)}</Meta>
              <Meta label="Agent">
                {v.agent ? [v.agent.agent, v.agent.model].filter(Boolean).join(' · ') || '—' : '—'}
              </Meta>
              <Meta label="Attempts">{v.attempts}</Meta>
              {v.incorporates ? (
                <Meta label="Feedback">
                  {v.incorporates} comment{v.incorporates === 1 ? '' : 's'} from v{v.parentN}
                </Meta>
              ) : null}
              {v.timings?.endedAt && v.timings.startedAt ? (
                <Meta label="Took">
                  {duration(
                    (new Date(v.timings.endedAt).getTime() - new Date(v.timings.startedAt).getTime()) / 1000,
                  )}
                </Meta>
              ) : null}
              {v.links.netlifyRun ? (
                <Anchor href={v.links.netlifyRun} target="_blank" size="sm" c="var(--va-muted)" mt={4}>
                  <Group gap={4}>
                    View the run in Netlify <IconExternalLink size={14} />
                  </Group>
                </Anchor>
              ) : null}
            </Stack>
          </Card>
        </div>
      </div>
    </>
  )
}
