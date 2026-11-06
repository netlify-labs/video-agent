import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Card,
  CopyButton,
  Group,
  Loader,
  Menu,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { FavoriteButton } from '../components/FavoriteButton'
import { RemixDialog, useCanRemix } from '../components/RemixDialog'
import { RestyleDialog, canRestyle } from '../components/RestyleDialog'
import { useMediaKeys } from '../lib/media-keys'
import { MediaChips, type Media } from '../components/MediaPicker'
import { PlanPanel } from '../components/PlanPanel'
import { ScenePicker } from '../components/ScenePicker'
import { PosterMenu } from '../components/PosterMenu'
import { PublishButton } from '../components/PublishDialog'
import { PublishToMenu, PublishedTo, destinationsActive } from '../components/Destinations'
import { TranscriptEditor } from '../components/TranscriptEditor'
import { SoundControl, soundAfterPick, type Sound } from '../components/SoundControl'
import { engineName, soundsFor } from '../lib/engines'
import {
  VoiceoverControl,
  sameVoice,
  voiceInput,
  voiceStateFrom,
  type VoiceState,
} from '../components/VoiceoverControl'
import { CommentsCard, ReviewPlayer, VerdictBar, type Pin } from '../components/Review'
import { CompositionPreview } from '../components/CompositionPreview'
import { DetailsButton, DetailsCard, VersionDetailsModal } from '../components/VersionDetails'
import { AttachButton, DropTarget, PendingUploads, useAttachUploads } from '../components/AttachFiles'
import { LanguageSelect, languageName } from '../components/LanguageSelect'
import {
  IconBell,
  IconBellRinging,
  IconDots,
  IconArrowsShuffle,
  IconPalette,
  IconDownload,
  IconExternalLink,
  IconLanguage,
  IconLock,
  IconLockOpen,
} from '@tabler/icons-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  canNotify,
  doneMessage,
  isWatched,
  readPref,
  savePref,
  subscribeWatches,
  unwatchRun,
  watchRun,
} from '../lib/run-notify'
import { isScopeRefusal, redidLabel, scopedStart } from '../lib/scenes'
import {
  $api,
  errorMessage,
  fetchClient,
  newIdempotencyKey,
  videoInit,
  type Version,
  type Video,
} from '../api/client'
import {
  CopyField,
  STATUS_WORD,
  Status,
  VersionImage,
  clockTime,
  confirmDanger,
  credits,
  duration,
  fileUrl,
  inProgress,
  relativeTime,
  showError,
  useAfterWrite,
} from '../components/bits'

/** Versions whose editing record this page already tried to repair (once per page load). */
const healed = new Set<string>()

const STAGE_WORDS: Record<string, string> = {
  queued: 'Waiting for a free slot',
  finding_music: 'Finding music…',
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
const notifyOn = () => readPref() && canNotify()

/**
 * "From GitHub: acme/web#123" for an externalRef like github:acme/web#pr-123 (github-action plan §6.2); other schemes
 * show as they are.
 */
function externalLabel(ref: string): { from: string; text: string } {
  const i = ref.indexOf(':')
  const scheme = ref.slice(0, i)
  const rest = ref.slice(i + 1)
  if (scheme === 'github') return { from: 'From GitHub:', text: rest.replace(/#pr-(\d+)$/, '#$1') }
  return { from: `From ${scheme}:`, text: rest }
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
  const afterWrite = useAfterWrite()
  // The agent's latest composition snapshot, when its checkpoints send one (plan v2 §6 A2). Same query as Narration.
  const progress = useProgress(video, v)
  const snapshot =
    progress.data?.versionN === v.n && progress.data.checkpoint?.hasBundle ? progress.data.checkpoint : null
  // The live stage and music pick when /progress has them, else the version's.
  const live = progress.data?.versionN === v.n ? progress.data : null
  const stage = live?.stage ?? v.stage ?? 'queued'
  const music = live?.music ?? v.music
  const cancel = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/cancel', afterWrite)
  const [notify, setNotify] = useState(notifyOn)
  const [notifyBlocked, setNotifyBlocked] = useState(
    () => 'Notification' in window && Notification.permission === 'denied',
  )
  // With Notify on, RunWatcher (app-wide) watches this run, so the notification comes on another page or with the
  // tab in the background too. Turned on for an earlier run, it carries over to this one.
  useEffect(() => {
    if (notify) watchRun(video.id)
  }, [notify, video.id])
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
          <Group justify="space-between" align="center" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              {/* A real loading state: a spinner beside what's happening (its label is the stage, for screen readers). */}
              <div
                role="img"
                aria-label={`Stage: ${stage === 'finding_music' ? 'Finding music' : STATUS_WORD[v.status]}`}
                style={{ display: 'grid' }}
              >
                <Loader size={26} color="var(--va-accent)" />
              </div>
              <Text fw={600} size="lg">
                {v.status === 'queued' ? `Version ${v.n} is queued` : `Making version ${v.n}`}
              </Text>
            </Group>
            <Text size="xl" fw={500} className="num" aria-label="Elapsed">
              {clock(v.timings?.queuedAt)}
            </Text>
          </Group>
          <Text size="sm" c="var(--va-muted)" data-testid="stage-words">
            {STAGE_WORDS[stage] ?? 'Working'}
          </Text>
          {music?.title && (music.status === 'picked' || music.status === 'importing') ? (
            <Text size="sm" c="var(--va-muted)" lineClamp={1} data-testid="picked-music">
              Music: {music.title}
              {music.status === 'importing' ? ' (adding it to the library)' : ''}
              {music.status === 'picked' && music.source === 'library' ? ' (from your library)' : ''}
            </Text>
          ) : null}
          <Narration video={video} v={v} />
          <Group justify="space-between" mt="xs">
            {'Notification' in window ? (
              <Tooltip
                label="Notifications are blocked for this site. Allow them in your browser's site settings."
                disabled={!notifyBlocked}
                multiline
                w={260}
              >
                <Button
                  size="xs"
                  variant={notify ? 'filled' : 'light'}
                  leftSection={notify ? <IconBellRinging size={16} /> : <IconBell size={16} />}
                  aria-pressed={notify}
                  data-testid="notify-toggle"
                  onClick={() => {
                    const on = !notify
                    const save = (x: boolean) => {
                      setNotify(x)
                      savePref(x)
                      if (!x) unwatchRun(video.id)
                    }
                    if (on && Notification.permission !== 'granted')
                      void Notification.requestPermission().then((p) => {
                        setNotifyBlocked(p === 'denied')
                        save(p === 'granted')
                      })
                    else save(on)
                  }}
                >
                  {notify
                    ? "You'll be notified"
                    : notifyBlocked
                      ? 'Notifications blocked'
                      : "Notify me when it's done"}
                </Button>
              </Tooltip>
            ) : (
              <span />
            )}
            <Group gap="sm">
              {v.links.netlifyRun ? (
                <Anchor
                  href={v.links.netlifyRun}
                  target="_blank"
                  size="xs"
                  c="var(--va-muted)"
                  data-testid="progress-run-link"
                >
                  <Group gap={4} wrap="nowrap">
                    View agent run <IconExternalLink size={12} />
                  </Group>
                </Anchor>
              ) : null}
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
  onDetails,
}: {
  video: Video
  selected: number
  onSelect: (n: number) => void
  onDetails: (n: number) => void
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
            <div key={x.n} className="va-version-wrap">
              <button
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
                    // A black frame with a spinner while it's being made; just the frame if it stopped.
                    <div
                      className="va-poster-wait"
                      role="img"
                      aria-label={`Stage: ${x.stage === 'finding_music' && x.status === 'running' ? 'Finding music' : STATUS_WORD[x.status]}`}
                    >
                      {inProgress(x.status) ? <Loader size={18} color="var(--va-accent)" /> : null}
                    </div>
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
                  {x.scope ? (
                    <Text size="xs" fw={500} c="var(--va-accent)" data-testid="version-scope">
                      {redidLabel(x.scope)}
                    </Text>
                  ) : null}
                  <Text size="sm" c="var(--va-muted)" lineClamp={2}>
                    {x.prompt}
                  </Text>
                  <Text size="xs" c="var(--va-faint)">
                    {relativeTime(x.createdAt)}
                    {pub ? ' · Public' : ''}
                  </Text>
                </div>
              </button>
              <div className="va-version-info">
                <DetailsButton v={x} size="sm" onOpen={() => onDetails(x.n)} />
              </div>
            </div>
          )
        })}
      </Stack>
    </Card>
  )
}

/** CC BY media this version uses, credited the way the share page and embed credit it. */
function VersionCredits({ v }: { v: Version }) {
  if (!v.credits.length) return null
  const link = (text: string, url: string | null) =>
    url ? (
      <Anchor href={url} target="_blank" rel="noopener" size="sm" c="inherit" td="underline">
        {text}
      </Anchor>
    ) : (
      text
    )
  return (
    <Card data-testid="version-credits">
      <Text fw={600} mb={6}>
        Credits
      </Text>
      <Stack gap={4}>
        {v.credits.map((c) => (
          <Text key={c.mediaId ?? c.text} size="sm" c="var(--va-muted)">
            {c.role}: {link(c.title, c.sourceUrl)}
            {c.creator ? <> by {link(c.creator, c.creatorUrl)}</> : null},{' '}
            {link(c.licenseLabel, c.licenseUrl)}
          </Text>
        ))}
      </Stack>
      <Text size="xs" c="var(--va-faint)" mt={6}>
        Shown on the share page and in the embed. Keep it with the video wherever you post it.
      </Text>
    </Card>
  )
}

function PublicLink({ video, v, canPublish }: { video: Video; v: Version; canPublish: boolean }) {
  const afterWrite = useAfterWrite()
  const unpublish = $api.useMutation('delete', '/api/v1/videos/{id}/versions/{n}/publish', afterWrite)
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
        {live.urls.narration ? <CopyField label="Narration (MP3)" value={live.urls.narration} /> : null}
        {live.urls.transcript ? <CopyField label="Transcript" value={live.urls.transcript} /> : null}
        <CopyField label="Embed" value={live.embed ?? ''} />
        {live.player ? (
          <div>
            <CopyField label="Player" value={live.player} />
            <Text size="xs" c="var(--va-faint)" mt={4}>
              The player keeps the credits and captions and sizes itself; it needs its script. The embed above
              needs none.
            </Text>
          </div>
        ) : null}
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

const TITLE_MAX = 120

/** The video's title, edited in place: click it, type, and it saves when you press Enter or click away. Escape
 * undoes the edit. Empty titles and unchanged ones aren't saved. */
function EditableTitle({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const ref = useRef<HTMLHeadingElement>(null)
  const finish = () => {
    const el = ref.current
    if (!el) return
    const next = el.textContent.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
    if (!next) el.textContent = title
    else if (next !== title) {
      el.textContent = next
      onSave(next)
    }
  }
  return (
    <Title
      ref={ref}
      order={1}
      className="va-title-edit"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      title="Click to edit title"
      style={{ overflowWrap: 'anywhere' }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.currentTarget.textContent = title
          e.currentTarget.blur()
        }
      }}
    >
      {title}
    </Title>
  )
}

/** What Remix does, for its tooltip and title. */
const REMIX_HINT =
  'Remix: make a new video of your own from this one. Say what to change, from swapping a name to a new topic in the same format.'

export function VideoPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const me = $api.useQuery('get', '/api/v1/me')
  const canCreate = me.data?.role === 'admin' || me.data?.role === 'creator'
  const config = $api.useQuery('get', '/api/v1/config')
  const canPlan = canCreate && config.data?.planningAvailable === true
  const canRedoScenes = config.data?.features.includes('scoped_revision') === true
  const [planningRevision, setPlanningRevision] = useState(false)
  // The version whose full details are open (How vN was made), if any.
  const [detailsN, setDetailsN] = useState<number | null>(null)
  const canRemix = useCanRemix()
  // ?remix=n (the share page's link) opens the Remix dialog for that version.
  const [search, setSearch] = useSearchParams()
  const [remixing, setRemixing] = useState<number | null>(null)
  const [restyling, setRestyling] = useState<number | null>(null)
  const looksOn = config.data?.features.includes('looks') === true
  // A watched run (Notify) is polled by RunWatcher on the same query, in the background too; polling here as well
  // would double the requests.
  const watched = useSyncExternalStore(subscribeWatches, () => isWatched(id))
  const video = $api.useQuery('get', '/api/v1/videos/{id}', videoInit(id), {
    refetchInterval: (q) =>
      !watched && q.state.data && (inProgress(q.state.data.status) || destinationsActive(q.state.data))
        ? 5000
        : false,
  })
  const [selected, setSelected] = useState<number | null>(null)
  const [revision, setRevision] = useState('')
  const [revMedia, setRevMedia] = useState<Media[]>([])
  // null keeps the sound of the version being revised.
  const [revSound, setRevSound] = useState<Sound | null>(null)
  // null keeps the voice-over of the version being revised.
  const [revVoice, setRevVoice] = useState<VoiceState | null>(null)
  const [revKey, setRevKey] = useState(newIdempotencyKey)
  // Redo a scene: whole video (the default) or some scenes of the shown version, and which.
  const [revScenes, setRevScenes] = useState(false)
  const [revBeats, setRevBeats] = useState<string[]>([])
  const revBox = useRef<HTMLTextAreaElement>(null)
  const revMediaBody = revMedia.length ? { mediaIds: revMedia.map((m) => m.id) } : {}
  // Files dropped on the revision box upload to the library and are attached when ready (set below, once the
  // version's sound is known).
  const revAppend = useRef<(m: Media) => void>(() => undefined)
  const revUploads = useAttachUploads((m) => {
    revAppend.current(m)
  })
  const prevStatus = useRef<string | null>(null)
  const player = useRef<HTMLVideoElement>(null)
  const [picking, setPicking] = useState(false)
  const [pending, setPending] = useState<Pin | null>(null)
  const [view, setView] = useState<'video' | 'composition'>('video')
  // Switching to a scoped version starts its player at the first scene it redid (once the new element has loaded).
  const [seekTo, setSeekTo] = useState<number | null>(null)
  const select = (n: number) => {
    const x = video.data?.versions.find((y) => y.n === n)
    setSeekTo(x && x.status === 'ready' ? scopedStart(x) : null)
    setSelected(n)
    setRevSound(null)
    setRevVoice(null)
    setRevBeats([])
    setPicking(false)
    setPending(null)
  }
  useEffect(() => {
    const el = player.current
    if (seekTo === null || !el) return
    const go = () => {
      el.currentTime = seekTo
      setSeekTo(null)
    }
    if (el.readyState >= 1) {
      go()
      return
    }
    el.addEventListener('loadedmetadata', go, { once: true })
    return () => {
      el.removeEventListener('loadedmetadata', go)
    }
  }, [seekTo, selected])

  const revise = $api.useMutation('post', '/api/v1/videos/{id}/versions', {
    onSuccess: () => {
      setRevision('')
      setRevMedia([])
      setRevSound(null)
      setRevVoice(null)
      setRevScenes(false)
      setRevBeats([])
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
  // A ready agent-made version that isn't editable may only be missing its record (finalize's bundle step failed):
  // loading its preview link once makes the bundle and records the contract, then the video is read again.
  const healN =
    data?.versions.find((x) => x.n === selected) ?? data?.versions.find((x) => x.status === 'ready')
  const heal =
    healN &&
    healN.status === 'ready' &&
    !healN.editable &&
    healN.mode === 'author' &&
    // Only HyperFrames versions have an editing record to repair; another engine's isn't editable at all.
    healN.editing.engine === 'hyperframes'
      ? healN.n
      : null
  useEffect(() => {
    if (heal === null || !data) return
    const key = `${data.id}/${heal}`
    if (healed.has(key)) return
    healed.add(key)
    void fetchClient
      .GET('/api/v1/videos/{id}/versions/{n}/preview', { params: { path: { id: data.id, n: heal } } })
      .then(({ data: link }) => {
        if (link) void video.refetch()
      })
  }, [heal, data?.id])
  // Space plays and pauses the video, ← and → step through it (not while typing or on a control's own keys).
  useMediaKeys({
    // Only while the video itself is on screen (not the live composition, nor a version still being made).
    enabled: () => view === 'video' && player.current !== null && player.current.closest('[hidden]') === null,
    toggle: () => {
      const p = player.current
      if (!p) return
      if (p.paused) void p.play().catch(() => undefined)
      else p.pause()
    },
    seekBy: (d) => {
      const p = player.current
      if (!p) return
      p.currentTime = Math.min(
        Math.max(p.currentTime + d, 0),
        Number.isFinite(p.duration) ? p.duration : p.currentTime + d,
      )
    },
  })
  useEffect(() => {
    const asked = search.get('remix')
    // Waits until this person is known to be able to remix (the config and role load after the video).
    if (!asked || !data || !canRemix) return
    setRemixing(Number(asked) || null)
    const next = new URLSearchParams(search)
    next.delete('remix')
    setSearch(next, { replace: true })
  }, [data, search, canRemix, setSearch])
  useEffect(() => {
    if (!data) return
    const was = prevStatus.current
    prevStatus.current = data.status
    if (was && inProgress(was as Video['status']) && !inProgress(data.status)) {
      // The browser notification, when asked for, is RunWatcher's.
      const msg = doneMessage(data.title, data.status)
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
  const sound = revSound ?? v.sound
  const pickRevMedia = (next: Media[]) => {
    const s = soundAfterPick(sound, revSound !== null, revMedia, next)
    if (s !== sound) setRevSound(s)
    setRevMedia(next)
  }
  revAppend.current = (m) => {
    setRevMedia((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]))
    const s = soundAfterPick(sound, revSound !== null, revMedia, [...revMedia, m])
    if (s !== sound) setRevSound(s)
  }
  const voice = revVoice ?? voiceStateFrom(v.voiceover)
  const voiceChanged = revVoice !== null && !sameVoice(revVoice, voiceStateFrom(v.voiceover))
  // Why this version's scenes can't be redone one by one, if they can't.
  const scenesBlocked = !v.editable
    ? "This version doesn't keep the editing contract, so it can only be revised whole."
    : v.editing.capabilities.scopedRevision
      ? null
      : "This version's engine can't redo single scenes, so it can only be revised whole."
  const scoped = canRedoScenes && revScenes && scenesBlocked === null
  const makeRevision = (planId?: string | null) => {
    if (scoped) {
      // Length, sound, voice-over and plan stay the parent's: the server refuses them with a scope.
      revise.mutate({
        params: { path: { id }, header: { 'idempotency-key': revKey } },
        body: { prompt: revision, fromVersion: v.n, scope: { beats: revBeats }, ...revMediaBody },
      })
      return
    }
    revise.mutate({
      params: { path: { id }, header: { 'idempotency-key': revKey } },
      body: {
        prompt: revision,
        fromVersion: v.n,
        ...(planId ? { planId } : {}),
        ...revMediaBody,
        ...(revSound ? { sound: revSound } : {}),
        // Sent only when changed. A plan carries a voice-over it was given; turning it off is always sent.
        ...(voiceChanged && (!planId || !voice.enabled) ? { voiceover: voiceInput(voice) } : {}),
      },
    })
  }

  const sub = inProgress(latest.status)
    ? `Making v${latest.n}${latest.parentN ? ` from v${latest.parentN}` : ''}. ${data.versions.some((x) => x.status === 'ready') ? 'Earlier versions are below.' : 'Usually ready in 3 to 8 minutes.'}`
    : v.status === 'ready' && v.output
      ? `v${v.n} · ${duration(v.output.durationSec)} · ${v.output.width}×${v.output.height} · ${data.owner.name ?? data.owner.email?.split('@')[0] ?? ''} · ${relativeTime(v.createdAt)}`
      : `v${v.n} ${v.status === 'timed_out' ? 'timed out' : v.status}${v.error ? `: ${v.error.message}` : ''}`

  return (
    <>
      {/* No breadcrumb (Library is in the nav): the title sits at the top, so the video and comments fit. */}
      <div className="va-title-row va-video-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          {canPublish ? (
            <EditableTitle
              title={data.title}
              onSave={(title) => {
                rename.mutate({ params: { path: { id } }, body: { title } })
              }}
            />
          ) : (
            <Title order={1} style={{ overflowWrap: 'anywhere' }}>
              {data.title}
            </Title>
          )}
          <div className="va-sub num">{sub}</div>
          {data.externalRef ? (
            <div className="va-sub" data-testid="external-ref">
              {externalLabel(data.externalRef).from}{' '}
              {data.externalUrl ? (
                <Anchor href={data.externalUrl} target="_blank" rel="noopener noreferrer" inherit>
                  {externalLabel(data.externalRef).text}
                </Anchor>
              ) : (
                externalLabel(data.externalRef).text
              )}
            </div>
          ) : null}
          {data.remixOf ? (
            <div className="va-sub" data-testid="remix-of">
              Remix of{' '}
              <Anchor component={Link} to={`/videos/${data.remixOf.id}`} inherit>
                {data.remixOf.title}
              </Anchor>{' '}
              v{data.remixOf.n}
            </div>
          ) : null}
        </div>
        <Group gap="sm">
          {remixing !== null && data.versions.some((x) => x.n === remixing && x.status === 'ready') ? (
            <RemixDialog
              video={data}
              version={data.versions.find((x) => x.n === remixing) as Version}
              opened
              onClose={() => {
                setRemixing(null)
              }}
            />
          ) : null}
          {restyling !== null ? (
            <RestyleDialog
              video={data}
              version={data.versions.find((x) => x.n === restyling) as Version}
              opened
              onClose={() => {
                setRestyling(null)
              }}
            />
          ) : null}
          {v.status === 'ready' && canCreate ? (
            <Tooltip
              label={
                v.editing.capabilities.editOps.length === 0
                  ? `Editing isn't available for ${engineName(v.editing.engine)} videos yet. Ask for a revision instead.`
                  : "This version can't be edited in the browser. Ask for a revision instead."
              }
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
          {canPublish ? <PublishToMenu video={data} v={v} /> : null}
          {v.status === 'ready' && canPublish && !live ? (
            <PublishButton
              v={v}
              userId={me.data?.id ?? ''}
              loading={publish.isPending}
              onPublish={(body) => {
                publish.mutate({ params: { path: { id: data.id, n: v.n } }, body })
              }}
            />
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
                {canCreate && canRestyle(v, looksOn) ? (
                  <Menu.Item
                    hiddenFrom="sm"
                    leftSection={<IconPalette size={14} />}
                    onClick={() => {
                      setRestyling(v.n)
                    }}
                  >
                    Restyle…
                  </Menu.Item>
                ) : null}
                {v.status === 'ready'
                  ? (
                      [
                        'poster',
                        'gif',
                        'captions',
                        ...(v.links.narrationAudio ? (['narration-audio'] as const) : []),
                        ...(v.links.transcript ? (['transcript'] as const) : []),
                      ] as const
                    ).map((f) => (
                      <Menu.Item
                        key={f}
                        component="a"
                        href={fileUrl(data.id, v.n, f, true)}
                        leftSection={<IconDownload size={14} />}
                      >
                        Download{' '}
                        {f === 'gif' ? 'GIF preview' : f === 'narration-audio' ? 'narration (MP3)' : f}
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
                  leftSection={<IconLanguage size={14} />}
                  onClick={() => {
                    let language = data.language
                    modals.openConfirmModal({
                      title: 'Language',
                      children: (
                        <LanguageSelect
                          defaultValue={data.language}
                          onChange={(l) => {
                            language = l
                          }}
                        />
                      ),
                      labels: { confirm: 'Save', cancel: 'Cancel' },
                      onConfirm: () => {
                        rename.mutate({ params: { path: { id } }, body: { language } })
                      },
                    })
                  }}
                  data-testid="video-language"
                >
                  Language: {languageName(data.language)}
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
          {/* Actions on this video sit right above it: the view toggle, then remix (labelled), favorite, poster and download. */}
          <Group justify="space-between" gap="xs" wrap="nowrap" data-testid="video-actions">
            {!showProgress && v.status === 'ready' ? (
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
            ) : (
              <span />
            )}
            <Group gap={6} wrap="nowrap">
              {v.status === 'ready' && canRemix ? (
                <Tooltip label={REMIX_HINT} multiline w={260}>
                  <Button
                    variant="default"
                    h={36}
                    radius="md"
                    leftSection={<IconArrowsShuffle size={18} />}
                    title={REMIX_HINT}
                    onClick={() => {
                      setRemixing(v.n)
                    }}
                  >
                    Remix
                  </Button>
                </Tooltip>
              ) : null}
              {/* Phones get Restyle in the More actions menu: the row has no room for another icon. */}
              {canCreate && canRestyle(v, looksOn) ? (
                <Tooltip label="Restyle: a new version in another look">
                  <ActionIcon
                    visibleFrom="sm"
                    variant="default"
                    size={36}
                    radius="md"
                    aria-label={`Restyle v${v.n}`}
                    onClick={() => {
                      setRestyling(v.n)
                    }}
                  >
                    <IconPalette size={18} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
              <FavoriteButton videoId={data.id} favorite={data.favorite} />
              {v.status === 'ready' && canPublish ? (
                <PosterMenu
                  videoId={data.id}
                  v={v}
                  dimensions={v.output ?? data.dimensions}
                  time={() => player.current?.currentTime ?? 0}
                  frameDisabled={view === 'composition' ? 'Switch to Video to pick a frame.' : undefined}
                />
              ) : null}
              {v.status === 'ready' ? (
                <Tooltip label={`Download v${v.n} (MP4)`}>
                  <ActionIcon
                    component="a"
                    href={fileUrl(data.id, v.n, 'video', true)}
                    variant="default"
                    size={36}
                    radius="md"
                    aria-label="Download the MP4"
                    title={`Download v${v.n} (MP4)`}
                  >
                    <IconDownload size={18} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
            </Group>
          </Group>
          {showProgress ? (
            <Progress video={data} v={latest} canCancel={canAct(latest.authorId)} />
          ) : v.status === 'ready' ? (
            <Stack gap="xs">
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
              {v.output?.notices.length ? (
                <Alert color="yellow" variant="light" data-testid="output-notices">
                  {v.output.notices.map((n) => (
                    <Text key={n} size="sm">
                      {n} Kept as made; ask for a revision to change it.
                    </Text>
                  ))}
                </Alert>
              ) : null}
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
                      {v.scope && v.parentN !== null && isScopeRefusal(v.error?.message) ? (
                        // Retrying carries the refusal into the next run; a whole revision may be what's needed.
                        <Button
                          variant="default"
                          disabled={busy}
                          onClick={() => {
                            select(v.parentN ?? 1)
                            setRevScenes(false)
                            setRevision(v.prompt)
                            revBox.current?.scrollIntoView({ block: 'center' })
                            revBox.current?.focus()
                          }}
                        >
                          Revise the whole video
                        </Button>
                      ) : null}
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
                  if (canPlan && !scoped) {
                    setPlanningRevision(true)
                    return
                  }
                  makeRevision()
                }}
              >
                <Stack gap="sm">
                  <Group justify="space-between" gap="xs">
                    <Group gap="sm">
                      <Text fw={600}>Revise and regenerate this video</Text>
                      <AttachButton
                        value={revMedia}
                        onChange={pickRevMedia}
                        disabled={busy || v.status !== 'ready' || planningRevision}
                      />
                    </Group>
                    <Text size="sm" c="var(--va-faint)">
                      {busy
                        ? 'Wait for the version in progress'
                        : v.status === 'ready'
                          ? `Starts from v${v.n}`
                          : 'Pick a ready version'}
                    </Text>
                  </Group>
                  {canRedoScenes && v.status === 'ready' ? (
                    <Stack gap={6} data-testid="revise-scope">
                      <SegmentedControl
                        size="xs"
                        w="fit-content"
                        value={scoped ? 'scenes' : 'whole'}
                        disabled={busy || planningRevision}
                        onChange={(x) => {
                          setRevScenes(x === 'scenes')
                        }}
                        data={[
                          { value: 'whole', label: 'Whole video' },
                          { value: 'scenes', label: 'Some scenes', disabled: scenesBlocked !== null },
                        ]}
                      />
                      {scenesBlocked ? (
                        <Text size="sm" c="var(--va-faint)">
                          {scenesBlocked}
                        </Text>
                      ) : scoped ? (
                        <>
                          <ScenePicker
                            key={`${id}-${v.n}`}
                            videoId={id}
                            v={v}
                            value={revBeats}
                            onChange={setRevBeats}
                            disabled={busy}
                            onPreview={(b) => {
                              // Hovering a scene shows where it starts.
                              if (player.current && view === 'video') player.current.currentTime = b.start
                            }}
                          />
                          <Text size="sm" c="var(--va-faint)">
                            Length, sound and voice stay as they are. Say in the request if a scene should run
                            longer.
                          </Text>
                        </>
                      ) : null}
                    </Stack>
                  ) : null}
                  <DropTarget
                    onFiles={(fs) => void revUploads.add(fs)}
                    disabled={busy || v.status !== 'ready' || planningRevision}
                  >
                    <Textarea
                      ref={revBox}
                      aria-label="What should change?"
                      autosize
                      minRows={3}
                      placeholder='What should change? For example: "make the end card say Start free today". Drop files here to attach them.'
                      value={revision}
                      disabled={busy || v.status !== 'ready'}
                      onChange={(e) => {
                        setRevision(e.currentTarget.value)
                      }}
                    />
                  </DropTarget>
                  <PendingUploads pending={revUploads.pending} onDismiss={revUploads.dismiss} />
                  <MediaChips
                    value={revMedia}
                    onChange={pickRevMedia}
                    disabled={busy || v.status !== 'ready' || planningRevision}
                    button={false}
                  />
                  {scoped ? null : (
                    <>
                      <SoundControl
                        value={sound}
                        media={revMedia}
                        disabled={busy || v.status !== 'ready' || planningRevision}
                        allowed={soundsFor(v.editing.capabilities)}
                        onChange={(s) => {
                          setRevSound(s === v.sound ? null : s)
                        }}
                      />
                      {/* An engine without voice-over (Remotion today) never offers it (render-engines §4.1). */}
                      {v.editing.capabilities.voiceover ? (
                        <VoiceoverControl
                          value={voice}
                          disabled={busy || v.status !== 'ready' || planningRevision}
                          planning={canPlan}
                          onChange={setRevVoice}
                        />
                      ) : null}
                    </>
                  )}
                  <Group gap={0} className={canPlan && !scoped ? 'va-split-button' : undefined}>
                    <Button
                      type="submit"
                      disabled={
                        busy ||
                        v.status !== 'ready' ||
                        revision.trim().length < 3 ||
                        planningRevision ||
                        (scoped && revBeats.length === 0)
                      }
                      loading={revise.isPending && (!canPlan || scoped)}
                    >
                      {canPlan && !scoped ? 'Plan it first' : `Make v${data.versions.length + 1}`}
                    </Button>
                    {canPlan && !scoped ? (
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
              sound={sound}
              voiceover={voice.enabled ? voiceInput(voice) : undefined}
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
        </div>

        <div className="va-rail">
          {/* Where this version is published comes first, right under the actions; then the versions. */}
          <PublicLink video={data} v={v} canPublish={canPublish} />
          <PublishedTo v={v} canPublish={canPublish} />
          <Filmstrip video={data} selected={v.n} onSelect={select} onDetails={setDetailsN} />
          {v.status === 'ready' ? <TranscriptEditor videoId={data.id} v={v} canEdit={canPublish} /> : null}
          <DetailsCard video={data} v={v} onOpen={() => setDetailsN(v.n)} />
          <Card>
            <Text fw={600} mb={8}>
              {v.output?.summary ? 'What the agent made' : 'The request'}
            </Text>
            <Text size="sm" c="var(--va-muted)" style={{ whiteSpace: 'pre-wrap' }}>
              {v.output?.summary ?? v.prompt}
            </Text>
          </Card>
          <VersionCredits v={v} />
        </div>
      </div>
      <VersionDetailsModal
        video={data}
        v={data.versions.find((x) => x.n === detailsN) ?? null}
        opened={detailsN !== null}
        onClose={() => {
          setDetailsN(null)
        }}
      />
    </>
  )
}
