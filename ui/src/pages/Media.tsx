// The media library (plan v2 §9): the team's logos, screenshots, clips, music and fonts. Creators and admins drop files in
// (bigger ones upload in resumable parts); everyone can browse and see where an item is used. Your voice-over
// recordings are left out of the list and shown under the Recordings filter (plan 2026-11-02 §2.3), with where each is
// used, a way back to its video, and Delete unused recordings.
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  FileButton,
  Group,
  Menu,
  Progress,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { IconDots, IconMusic, IconUpload } from '@tabler/icons-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { $api, useCanCreate } from '../api/client'
import { confirmDanger, relativeTime, showError } from '../components/bits'
import { FindMusicModal } from '../components/FindMusic'
import { MEDIA_ACCEPT, Thumb, type Media } from '../components/MediaPicker'
import { planUploads, retireReplaced, type PlannedUpload } from '../components/Duplicates'
import {
  editMediaDetails,
  LibraryToolbar,
  MediaTable,
  mediaName,
  recordingUse,
  SourceLine,
  useLibraryControls,
} from '../components/MediaLibrary'
import { uploadFile, type UploadProgress } from '../lib/upload'

type Kind = 'all' | 'image' | 'svg' | 'video' | 'audio' | 'font' | 'pdf' | 'recordings'

interface Job {
  key: string
  name: string
  progress: UploadProgress | null
  error: string | null
  file: File
  /** The library item this upload replaces, removed once the new one is in. */
  replaces: PlannedUpload['replaces']
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`

/** An item's menu: rename it and edit its notes, or delete it (uploader or admin); a recording also opens its video. */
function MediaActions({ m }: { m: Media }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media'] })
  const remove = $api.useMutation('delete', '/api/v1/media/{id}', { onSuccess: refresh, onError: showError })
  const videoId = m.recording?.videoId
  if (!m.canDelete) return null
  return (
    <Menu position="bottom-end">
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Actions for ${mediaName(m)}`}>
          <IconDots size={14} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          onClick={() => {
            editMediaDetails(m, refresh)
          }}
        >
          Edit name and notes
        </Menu.Item>
        {videoId ? (
          <Menu.Item
            onClick={() => {
              void navigate(`/videos/${videoId}`)
            }}
          >
            Open video
          </Menu.Item>
        ) : null}
        <Menu.Item
          color="red"
          onClick={() => {
            confirmDanger({
              title: `Delete ${mediaName(m)}?`,
              body: m.recording
                ? 'It leaves your recordings. Drafts and versions that already use it keep it.'
                : 'It leaves the library. Videos that already use it keep it.',
              confirm: 'Delete',
              onConfirm: () => {
                remove.mutate({ params: { path: { id: m.id } } })
              },
            })
          }}
        >
          Delete
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  )
}

function MediaCard({ m }: { m: Media }) {
  return (
    <Card padding={0} className="va-media-card" data-testid={`media-${m.id}`}>
      <Thumb m={m} />
      {m.kind === 'audio' && m.urls ? (
        // Plays from the signed URL; nothing loads until someone presses play.
        <audio
          className="va-media-audio"
          controls
          preload="none"
          src={m.urls.file}
          aria-label={`Play ${mediaName(m)}`}
          data-testid={`player-${m.id}`}
        />
      ) : null}
      <Stack gap={4} p="sm">
        <Group justify="space-between" wrap="nowrap" gap={4}>
          <Text size="sm" fw={600} truncate title={mediaName(m)}>
            {mediaName(m)}
          </Text>
          <MediaActions m={m} />
        </Group>
        {m.title ? (
          <Text size="xs" c="var(--va-faint)" truncate title={m.filename}>
            {m.filename}
          </Text>
        ) : null}
        <Text size="xs" c="var(--va-muted)" lineClamp={2}>
          {m.caption ?? 'No notes'}
        </Text>
        {m.source ? <SourceLine source={m.source} /> : null}
        {m.status === 'rejected' ? (
          <Text size="xs" c="red">
            {m.rejectReason}
          </Text>
        ) : null}
        <Group gap={6}>
          {m.status !== 'ready' ? (
            <Badge size="xs" variant="light" color={m.status === 'rejected' ? 'red' : 'gray'}>
              {m.status === 'rejected' ? 'Rejected' : 'Checking'}
            </Badge>
          ) : null}
          <Text size="xs" c="var(--va-faint)" className="num">
            {mb(m.bytes)} · {m.uploader.name ?? m.uploader.email?.split('@')[0]} · {relativeTime(m.createdAt)}
            {m.recording
              ? ` · ${recordingUse(m.recording)}`
              : m.usedIn
                ? ` · used in ${m.usedIn} video${m.usedIn === 1 ? '' : 's'}`
                : ''}
          </Text>
        </Group>
      </Stack>
    </Card>
  )
}

export function MediaPage() {
  const qc = useQueryClient()
  const canUpload = useCanCreate()
  const [kind, setKind] = useState<Kind>('all')
  const lib = useLibraryControls()
  const [jobs, setJobs] = useState<Job[]>([])
  const [dragging, setDragging] = useState(false)
  const [finding, setFinding] = useState(false)
  const recordings = kind === 'recordings'
  const list = $api.useQuery(
    'get',
    '/api/v1/media',
    {
      params: {
        query: recordings
          ? { recordings: 'only', ...lib.query }
          : { recordings: 'exclude', ...(kind === 'all' ? {} : { kind }), ...lib.query },
      },
    },
    {
      // Poll while something of yours is still being checked.
      refetchInterval: (q) => (q.state.data?.items.some((m) => m.status === 'verifying') ? 3000 : false),
    },
  )

  const clear = $api.useMutation('post', '/api/v1/media/recordings/delete-unused', {
    onSuccess: (r) => {
      notifications.show({
        message: r.deleted
          ? `Deleted ${String(r.deleted)} unused recording${r.deleted === 1 ? '' : 's'}.`
          : 'No unused recordings to delete.',
      })
      void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media'] })
    },
    onError: showError,
  })

  const setJob = (key: string, patch: Partial<Job>) => {
    setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)))
  }
  const run = async (job: Job) => {
    setJob(job.key, { error: null })
    try {
      await uploadFile(job.file, {
        onProgress: (p) => {
          setJob(job.key, { progress: p })
        },
      })
      if (job.replaces) await retireReplaced(job.replaces)
      setJobs((js) => js.filter((j) => j.key !== job.key))
    } catch (e) {
      setJob(job.key, { error: e instanceof Error ? e.message : String(e) })
    }
    void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media'] })
  }
  const add = async (picked: File[]) => {
    const next = (await planUploads(picked)).uploads.map(({ file, replaces }) => ({
      key: `${file.name}:${file.size}:${file.lastModified}:${Math.random()}`,
      name: file.name,
      progress: null,
      error: null,
      file,
      replaces,
    }))
    setJobs((js) => [...js, ...next])
    void (async () => {
      for (const j of next) await run(j)
    })()
  }

  const items = list.data?.items ?? []
  return (
    <>
      <div className="va-title-row">
        <div>
          <Title order={1}>Media</Title>
          <div className="va-sub">
            Logos, screenshots, clips, music, fonts and PDFs the agent can use in your videos.
          </div>
        </div>
        {canUpload ? (
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconMusic size={16} />}
              onClick={() => {
                setFinding(true)
              }}
            >
              Find music
            </Button>
            <FileButton multiple accept={MEDIA_ACCEPT} onChange={(fs) => void add(fs)}>
              {(props) => (
                <Button {...props} leftSection={<IconUpload size={16} />}>
                  Upload
                </Button>
              )}
            </FileButton>
          </Group>
        ) : null}
      </div>
      {canUpload ? (
        <FindMusicModal
          opened={finding}
          onClose={() => {
            setFinding(false)
          }}
        />
      ) : null}

      {canUpload ? (
        <div
          className="va-dropzone"
          data-active={dragging || undefined}
          data-testid="media-dropzone"
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => {
            setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            void add([...e.dataTransfer.files])
          }}
        >
          <Text size="sm" c="var(--va-muted)">
            Drop files here: PNG, JPEG, WebP or SVG images up to 5 MB, MP4 clips up to 100 MB and 2 minutes,
            MP3, M4A, WAV or Ogg audio up to 50 MB and 10 minutes, WOFF2, TTF or OTF fonts, and PDFs up to 20
            MB for the agent to read. Only upload music you have the rights to, or use Find music for CC0 and
            CC BY tracks from Openverse.
          </Text>
        </div>
      ) : null}

      {jobs.length ? (
        <Stack gap="xs" mb="md">
          {jobs.map((j) => (
            <Card key={j.key} padding="sm" data-testid="upload-job">
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm" truncate>
                  {j.name}
                </Text>
                <Text size="xs" c={j.error ? 'red' : 'var(--va-faint)'}>
                  {j.error ??
                    (j.progress?.phase === 'hashing'
                      ? 'Preparing…'
                      : j.progress?.phase === 'checking'
                        ? 'Checking…'
                        : j.progress
                          ? `${mb(j.progress.sent)} of ${mb(j.progress.total)}`
                          : 'Waiting…')}
                </Text>
              </Group>
              {j.error ? (
                <Group gap="xs" mt={6}>
                  <Button size="compact-xs" variant="default" onClick={() => void run(j)}>
                    Try again
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => {
                      setJobs((js) => js.filter((x) => x.key !== j.key))
                    }}
                  >
                    Dismiss
                  </Button>
                </Group>
              ) : (
                <Progress
                  mt={6}
                  size="sm"
                  value={j.progress ? (j.progress.sent / Math.max(1, j.progress.total)) * 100 : 0}
                />
              )}
            </Card>
          ))}
        </Stack>
      ) : null}

      <LibraryToolbar {...lib} />
      <SegmentedControl
        size="xs"
        my="md"
        value={kind}
        onChange={(v) => {
          setKind(v)
        }}
        data={[
          { value: 'all', label: 'All' },
          { value: 'image', label: 'Images' },
          { value: 'svg', label: 'SVG' },
          { value: 'video', label: 'Clips' },
          { value: 'audio', label: 'Audio' },
          { value: 'font', label: 'Fonts' },
          { value: 'pdf', label: 'PDFs' },
          { value: 'recordings', label: 'Recordings' },
        ]}
      />
      {recordings ? (
        <Group justify="space-between" mb="md" gap="xs">
          <Text size="sm" c="var(--va-muted)">
            Your voice-over recordings. One no draft or version uses is deleted 30 days after its last use.
          </Text>
          <Button
            size="xs"
            variant="default"
            color="red"
            loading={clear.isPending}
            onClick={() => {
              confirmDanger({
                title: 'Delete unused recordings?',
                body: "Your recordings that no draft or version uses are deleted now, and can't be brought back. Recordings in use are kept.",
                confirm: 'Delete unused',
                onConfirm: () => {
                  clear.mutate({})
                },
              })
            }}
          >
            Delete unused recordings
          </Button>
        </Group>
      ) : null}
      {!list.isLoading && items.length === 0 && lib.searching ? (
        <Card>
          <Text fw={600}>Nothing matches that search</Text>
          <Text size="sm" c="var(--va-muted)" mt={4}>
            Search looks at names, file names and notes. Give items names and notes to find them later.
          </Text>
        </Card>
      ) : !list.isLoading && items.length === 0 && recordings ? (
        <Card>
          <Text fw={600}>No recordings</Text>
          <Text size="sm" c="var(--va-muted)" mt={4}>
            Record a voice-over in a video&apos;s editor; your takes are listed here.
          </Text>
        </Card>
      ) : !list.isLoading && items.length === 0 ? (
        <Card>
          <Text fw={600}>Nothing here yet</Text>
          <Text size="sm" c="var(--va-muted)" mt={4}>
            {canUpload
              ? 'Upload your logo, product screenshots or a short clip, then pick them when you make a video.'
              : 'Creators can upload logos, screenshots and clips here.'}
          </Text>
        </Card>
      ) : lib.view === 'table' ? (
        <Card padding={0}>
          <MediaTable items={items} testIdPrefix="media-" actions={(m) => <MediaActions m={m} />} />
        </Card>
      ) : (
        <div className="va-media-grid">
          {items.map((m) => (
            <MediaCard key={m.id} m={m} />
          ))}
        </div>
      )}
    </>
  )
}
