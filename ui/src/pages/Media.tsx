// The media library (plan v2 §9): the team's logos, screenshots, clips and fonts. Creators and admins drop files in
// (bigger ones upload in resumable parts); everyone can browse and see where an item is used.
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
  TextInput,
  Title,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { IconDots, IconMovie, IconTypography, IconUpload } from '@tabler/icons-react'
import { useState } from 'react'
import { $api, errorMessage, useCanCreate } from '../api/client'
import type { paths } from '../api/schema'
import { relativeTime } from '../components/bits'
import { uploadFile, type UploadProgress } from '../lib/upload'

type Media = paths['/api/v1/media/{id}']['get']['responses'][200]['content']['application/json']
type Kind = 'all' | 'image' | 'svg' | 'video' | 'font'

interface Job {
  key: string
  name: string
  progress: UploadProgress | null
  error: string | null
  file: File
}

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`

function Thumb({ m }: { m: Media }) {
  if (!m.urls)
    return (
      <div className="va-media-thumb">
        <Text size="xs" c="var(--va-faint)">
          {m.status === 'rejected' ? 'Rejected' : 'Checking…'}
        </Text>
      </div>
    )
  if (m.kind === 'image' || m.kind === 'svg')
    return (
      <div className="va-media-thumb">
        <img src={m.urls.file} alt={m.caption ?? m.filename} loading="lazy" />
      </div>
    )
  if (m.kind === 'video')
    return (
      <div className="va-media-thumb">
        {m.urls.poster ? <img src={m.urls.poster} alt="" loading="lazy" /> : <IconMovie size={32} />}
        {m.durationSec ? <span className="va-media-duration num">{Math.round(m.durationSec)} s</span> : null}
      </div>
    )
  // A font shows a sample in itself.
  const family = `va-media-${m.id}`
  return (
    <div className="va-media-thumb">
      <style>{`@font-face { font-family: '${family}'; src: url('${m.urls.file}'); }`}</style>
      <span style={{ fontFamily: `'${family}', system-ui`, fontSize: 40 }}>Aa</span>
      <IconTypography size={14} style={{ position: 'absolute', right: 8, bottom: 8, opacity: 0.6 }} />
    </div>
  )
}

function MediaCard({ m }: { m: Media }) {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media'] })
  const [editing, setEditing] = useState(false)
  const [caption, setCaption] = useState(m.caption ?? '')
  const save = $api.useMutation('patch', '/api/v1/media/{id}', {
    onSuccess: () => {
      setEditing(false)
      refresh()
    },
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  })
  const remove = $api.useMutation('delete', '/api/v1/media/{id}', {
    onSuccess: refresh,
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  })
  return (
    <Card padding={0} className="va-media-card" data-testid={`media-${m.id}`}>
      <Thumb m={m} />
      <Stack gap={4} p="sm">
        <Group justify="space-between" wrap="nowrap" gap={4}>
          <Text size="sm" fw={600} truncate title={m.filename}>
            {m.filename}
          </Text>
          {m.canDelete ? (
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Actions for ${m.filename}`}>
                  <IconDots size={14} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  onClick={() => {
                    setEditing(true)
                  }}
                >
                  Edit caption
                </Menu.Item>
                <Menu.Item
                  color="red"
                  onClick={() => {
                    modals.openConfirmModal({
                      title: `Delete ${m.filename}?`,
                      children: (
                        <Text size="sm">It leaves the library. Videos that already use it keep it.</Text>
                      ),
                      labels: { confirm: 'Delete', cancel: 'Cancel' },
                      confirmProps: { color: 'red', variant: 'light' },
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
          ) : null}
        </Group>
        {editing ? (
          <TextInput
            size="xs"
            aria-label="Caption"
            maxLength={500}
            value={caption}
            onChange={(e) => {
              setCaption(e.currentTarget.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save.mutate({ params: { path: { id: m.id } }, body: { caption } })
              if (e.key === 'Escape') setEditing(false)
            }}
            rightSection={
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => {
                  save.mutate({ params: { path: { id: m.id } }, body: { caption } })
                }}
              >
                Save
              </Button>
            }
            rightSectionWidth={56}
          />
        ) : (
          <Text size="xs" c="var(--va-muted)" lineClamp={2}>
            {m.caption ?? 'No caption'}
          </Text>
        )}
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
            {m.usedIn ? ` · used in ${m.usedIn} video${m.usedIn === 1 ? '' : 's'}` : ''}
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
  const [jobs, setJobs] = useState<Job[]>([])
  const [dragging, setDragging] = useState(false)
  const list = $api.useQuery(
    'get',
    '/api/v1/media',
    { params: { query: kind === 'all' ? {} : { kind } } },
    {
      // Poll while something of yours is still being checked.
      refetchInterval: (q) => (q.state.data?.items.some((m) => m.status === 'verifying') ? 3000 : false),
    },
  )

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
      setJobs((js) => js.filter((j) => j.key !== job.key))
    } catch (e) {
      setJob(job.key, { error: e instanceof Error ? e.message : String(e) })
    }
    void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media'] })
  }
  const add = (files: File[]) => {
    const next = files.map((file) => ({
      key: `${file.name}:${file.size}:${file.lastModified}:${Math.random()}`,
      name: file.name,
      progress: null,
      error: null,
      file,
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
          <div className="va-sub">Logos, screenshots, clips and fonts the agent can use in your videos.</div>
        </div>
        {canUpload ? (
          <FileButton
            multiple
            accept="image/png,image/jpeg,image/webp,image/svg+xml,video/mp4,font/woff2,font/ttf,font/otf,.woff2,.ttf,.otf"
            onChange={add}
          >
            {(props) => (
              <Button {...props} leftSection={<IconUpload size={16} />}>
                Upload
              </Button>
            )}
          </FileButton>
        ) : null}
      </div>

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
            add([...e.dataTransfer.files])
          }}
        >
          <Text size="sm" c="var(--va-muted)">
            Drop files here: PNG, JPEG, WebP or SVG images up to 5 MB, MP4 clips up to 100 MB and 2 minutes,
            WOFF2, TTF or OTF fonts.
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

      <SegmentedControl
        size="xs"
        mb="md"
        value={kind}
        onChange={(v) => {
          setKind(v)
        }}
        data={[
          { value: 'all', label: 'All' },
          { value: 'image', label: 'Images' },
          { value: 'svg', label: 'SVG' },
          { value: 'video', label: 'Clips' },
          { value: 'font', label: 'Fonts' },
        ]}
      />
      {!list.isLoading && items.length === 0 ? (
        <Card>
          <Text fw={600}>Nothing here yet</Text>
          <Text size="sm" c="var(--va-muted)" mt={4}>
            {canUpload
              ? 'Upload your logo, product screenshots or a short clip, then pick them when you make a video.'
              : 'Creators can upload logos, screenshots and clips here.'}
          </Text>
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
