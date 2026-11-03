// Picking library media (plan v2 §9): chips under a prompt (create, revise, plan) and the library picker they open,
// which the editor also uses to swap a media slot. Only ready items can be picked; creators can upload from here.
import {
  ActionIcon,
  Button,
  FileButton,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconCheck,
  IconFileTypePdf,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconTypography,
  IconX,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { $api, useCanCreate } from '../api/client'
import type { paths } from '../api/schema'
import { uploadFile } from '../lib/upload'
import { planUploads, retireReplaced } from './Duplicates'
import { EditDetailsButton, LibraryToolbar, MediaTable, mediaName, useLibraryControls } from './MediaLibrary'
import { clockTime } from './bits'
import { FindMusicModal } from './FindMusic'

export type Media = paths['/api/v1/media/{id}']['get']['responses'][200]['content']['application/json']
export type MediaKind = Media['kind']

// A hint for the file dialog only: the server decides what a file is from its bytes.
export const MEDIA_ACCEPT =
  'image/png,image/jpeg,image/webp,image/svg+xml,video/mp4,audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav,audio/ogg,font/woff2,font/ttf,font/otf,application/pdf,.mp3,.m4a,.wav,.ogg,.opus,.woff2,.ttf,.otf,.pdf'
const MAX_PICKS = 12

export function Thumb({ m }: { m: Media }) {
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
  if (m.kind === 'audio')
    return (
      <div className="va-media-thumb">
        <IconMusic size={32} />
        {m.durationSec ? <span className="va-media-duration num">{duration(m.durationSec)}</span> : null}
      </div>
    )
  if (m.kind === 'pdf')
    return (
      <div className="va-media-thumb">
        <IconFileTypePdf size={32} />
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

/** 95 → "1:35". */
export const duration = (sec: number) => clockTime(Math.round(sec))

export const KIND_LABEL: Record<MediaKind, string> = {
  image: 'Images',
  svg: 'SVG',
  video: 'Clips',
  audio: 'Audio',
  font: 'Fonts',
  pdf: 'PDFs',
}

/**
 * The library as a picker. With `multiple`, items toggle and Done returns them all; otherwise a click picks one and
 * closes. `kinds` limits what can be picked (an image slot takes images and SVGs; a clip slot takes clips).
 */
export function MediaLibraryModal(props: {
  opened: boolean
  onClose: () => void
  onPick: (items: Media[]) => void
  title?: string
  kinds?: MediaKind[]
  multiple?: boolean
  selected?: Media[]
}) {
  const kinds = props.kinds ?? (['image', 'svg', 'video', 'audio', 'font', 'pdf'] as MediaKind[])
  const [filter, setFilter] = useState<'all' | MediaKind>('all')
  const [picked, setPicked] = useState<Media[]>(props.selected ?? [])
  const [uploading, setUploading] = useState(false)
  const [finding, setFinding] = useState(false)
  const canUpload = useCanCreate()
  const qc = useQueryClient()
  const lib = useLibraryControls()
  const list = $api.useQuery(
    'get',
    '/api/v1/media',
    {
      params: {
        // Recordings are placed on the Narration track, never picked as library media.
        query: {
          limit: 100,
          recordings: 'exclude',
          ...(kinds.length === 1 ? { kind: kinds[0] } : {}),
          ...lib.query,
        },
      },
    },
    {
      enabled: props.opened,
      refetchInterval: (q) => (q.state.data?.items.some((m) => m.status === 'verifying') ? 3000 : false),
    },
  )
  const items = (list.data?.items ?? []).filter(
    (m) => kinds.includes(m.kind) && (filter === 'all' || m.kind === filter) && m.status !== 'rejected',
  )
  const toggle = (m: Media) => {
    if (!props.multiple) {
      props.onPick([m])
      props.onClose()
      return
    }
    setPicked((ps) =>
      ps.some((x) => x.id === m.id)
        ? ps.filter((x) => x.id !== m.id)
        : ps.length >= MAX_PICKS
          ? ps
          : [...ps, m],
    )
  }
  // Files just uploaded here (dropped or chosen): once the library lists them, the picker shows their section.
  const [fresh, setFresh] = useState<string[]>([])
  // A replacing upload's new id → the id it replaced, so a selected old file becomes the new one.
  const [replacedBy, setReplacedBy] = useState<Record<string, string>>({})
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!fresh.length || !list.data) return
    const mine = list.data.items.filter((m) => fresh.includes(m.id))
    if (!mine.length) return
    const sections = [...new Set(mine.filter((m) => kinds.includes(m.kind)).map((m) => m.kind))]
    if (sections.length === 1 && sections[0]) setFilter(sections[0])
    else if (sections.length > 1) setFilter('all')
    const other = mine.find((m) => !kinds.includes(m.kind))
    if (other)
      notifications.show({
        message: `${other.filename} is in the library, but this picker only takes ${kinds.map((k) => KIND_LABEL[k].toLowerCase()).join(' and ')}.`,
      })
    const swaps = mine.filter((m) => replacedBy[m.id])
    if (swaps.length) setPicked((ps) => ps.map((x) => swaps.find((m) => replacedBy[m.id] === x.id) ?? x))
    setFresh((f) => f.filter((id) => !mine.some((m) => m.id === id)))
  }, [fresh, list.data])
  const upload = async (files: File[]) => {
    if (!files.length) return
    setUploading(true)
    const { uploads, existing } = await planUploads(files)
    // Files already in the library aren't uploaded again; the picker shows them like fresh uploads.
    if (existing.length) setFresh((ids) => [...ids, ...existing.map((m) => m.id)])
    for (const { file: f, replaces } of uploads) {
      try {
        const id = await uploadFile(f)
        if (id) setFresh((ids) => [...ids, id])
        if (id && replaces) setReplacedBy((r) => ({ ...r, [id]: replaces.id }))
        if (replaces) await retireReplaced(replaces)
      } catch (e) {
        notifications.show({
          color: 'red',
          message: `${f.name}: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    }
    setUploading(false)
    // Also marks the Media page's list stale, which would otherwise keep its cached copy for a while.
    void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media'] })
  }

  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title={props.title ?? 'Add media'}
      size="90%"
      padding="xl"
      // A fixed height: the list scrolls inside it, and the selection and buttons stay in view at the bottom.
      classNames={{ content: 'va-pick-modal', body: 'va-pick-body' }}
    >
      {/* Files dropped anywhere on it upload, like Upload. */}
      <Stack
        gap="md"
        className="va-media-drop"
        data-active={dragging || undefined}
        data-testid="media-modal-dropzone"
        {...(canUpload
          ? {
              onDragOver: (e: React.DragEvent) => {
                if (![...e.dataTransfer.types].includes('Files')) return
                e.preventDefault()
                setDragging(true)
              },
              onDragLeave: (e: React.DragEvent) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
              },
              onDrop: (e: React.DragEvent) => {
                e.preventDefault()
                setDragging(false)
                void upload([...e.dataTransfer.files])
              },
            }
          : {})}
      >
        {canUpload ? (
          <div className="va-dropzone va-dropzone-top" data-active={dragging || undefined}>
            <Text size="sm" c="var(--va-muted)">
              {uploading
                ? 'Uploading…'
                : 'Drop files anywhere here to add them: images, SVGs, clips, audio, fonts or PDFs.'}
            </Text>
          </div>
        ) : null}
        <Group justify="space-between">
          {kinds.length > 1 ? (
            <SegmentedControl
              size="xs"
              value={filter}
              onChange={(v) => {
                setFilter(v)
              }}
              data={[
                { value: 'all', label: 'All' },
                ...kinds.map((k) => ({ value: k, label: KIND_LABEL[k] })),
              ]}
            />
          ) : (
            <span />
          )}
          {canUpload ? (
            <Group gap="xs">
              {kinds.includes('audio') ? (
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => {
                    setFinding(true)
                  }}
                >
                  Find music
                </Button>
              ) : null}
              <FileButton multiple accept={MEDIA_ACCEPT} onChange={(fs) => void upload(fs)}>
                {(p) => (
                  <Button {...p} size="xs" variant="default" loading={uploading}>
                    Upload
                  </Button>
                )}
              </FileButton>
            </Group>
          ) : null}
        </Group>
        <LibraryToolbar {...lib} />
        {!list.isLoading && items.length === 0 ? (
          <Text size="sm" c="var(--va-muted)">
            {lib.searching
              ? 'Nothing matches that search.'
              : canUpload
                ? 'Nothing to pick yet. Drop or upload a file, or add some on the Media page.'
                : 'Nothing to pick yet. Creators can upload on the Media page.'}
          </Text>
        ) : lib.view === 'table' ? (
          <MediaTable
            items={items}
            testIdPrefix="pick-"
            select={{
              isOn: (m) => picked.some((x) => x.id === m.id),
              toggle,
              canPick: (m) => m.status === 'ready',
            }}
            actions={(m) =>
              m.canDelete ? (
                <EditDetailsButton
                  m={m}
                  onSaved={() => void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media'] })}
                />
              ) : null
            }
          />
        ) : (
          <div className="va-media-grid va-media-grid-pick">
            {items.map((m) => {
              const on = picked.some((x) => x.id === m.id)
              const ready = m.status === 'ready'
              return (
                <UnstyledButton
                  key={m.id}
                  className="va-media-card va-media-pick"
                  data-on={on || undefined}
                  aria-pressed={props.multiple ? on : undefined}
                  aria-label={`${mediaName(m)}${m.caption ? `, ${m.caption}` : ''}`}
                  disabled={!ready}
                  onClick={() => {
                    toggle(m)
                  }}
                  data-testid={`pick-${m.id}`}
                >
                  <Thumb m={m} />
                  {on ? (
                    <span className="va-pick-check" aria-hidden>
                      <IconCheck size={14} stroke={3} />
                    </span>
                  ) : null}
                  <Text size="xs" p={6} truncate title={mediaName(m)}>
                    {mediaName(m)}
                  </Text>
                </UnstyledButton>
              )
            })}
          </div>
        )}
        {canUpload && kinds.includes('audio') ? (
          <FindMusicModal
            opened={finding}
            onClose={() => {
              setFinding(false)
            }}
            onImported={(m) => {
              // An imported track is picked straight away (it's already in the list above, too).
              setFinding(false)
              if (!props.multiple) {
                props.onPick([m])
                props.onClose()
              } else if (!picked.some((x) => x.id === m.id) && picked.length < MAX_PICKS)
                setPicked((ps) => [...ps, m])
            }}
          />
        ) : null}
        {props.multiple ? (
          // What will be added, removable here, and a button that says what it does.
          <div className="va-pick-footer">
            <div className="va-pick-selected" aria-live="polite">
              {picked.length ? (
                <>
                  <Text size="xs" c="var(--va-muted)" fw={500}>
                    Selected ({picked.length} of up to {MAX_PICKS})
                  </Text>
                  <Group gap={6} mt={6}>
                    {picked.map((m) => (
                      <span key={m.id} className="va-media-chip" data-testid={`selected-${m.id}`}>
                        <span className="va-media-chip-name">{m.filename}</span>
                        <ActionIcon
                          size="xs"
                          variant="subtle"
                          color="gray"
                          aria-label={`Unselect ${m.filename}`}
                          onClick={() => {
                            setPicked((ps) => ps.filter((x) => x.id !== m.id))
                          }}
                        >
                          <IconX size={12} />
                        </ActionIcon>
                      </span>
                    ))}
                  </Group>
                </>
              ) : (
                <Text size="sm" c="var(--va-faint)">
                  Nothing selected yet. Click files above to select them.
                </Text>
              )}
            </div>
            <Group gap="sm" wrap="nowrap">
              <Button variant="default" onClick={props.onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  props.onPick(picked)
                  props.onClose()
                }}
              >
                {picked.length
                  ? `Add ${picked.length} to the video`
                  : (props.selected?.length ?? 0) > 0
                    ? 'Remove all'
                    : 'Done'}
              </Button>
            </Group>
          </div>
        ) : null}
      </Stack>
    </Modal>
  )
}

/** Picked media as removable chips, with a button that opens the picker. */
export function MediaChips(props: {
  value: Media[]
  onChange: (items: Media[]) => void
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <Group gap={6} align="center">
        {props.value.map((m) => (
          <span key={m.id} className="va-media-chip" data-testid={`chip-${m.id}`}>
            {m.urls && (m.kind === 'image' || m.kind === 'svg' || m.urls.poster) ? (
              <img src={m.kind === 'video' ? (m.urls.poster ?? '') : m.urls.file} alt="" />
            ) : m.kind === 'font' ? (
              <IconTypography size={14} />
            ) : m.kind === 'audio' ? (
              <IconMusic size={14} />
            ) : m.kind === 'pdf' ? (
              <IconFileTypePdf size={14} />
            ) : (
              <IconMovie size={14} />
            )}
            <span className="va-media-chip-name">{m.filename}</span>
            {props.disabled ? null : (
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                aria-label={`Remove ${m.filename}`}
                onClick={() => {
                  props.onChange(props.value.filter((x) => x.id !== m.id))
                }}
              >
                <IconX size={12} />
              </ActionIcon>
            )}
          </span>
        ))}
        <Button
          size="compact-sm"
          variant="subtle"
          color="gray"
          leftSection={<IconPhoto size={14} />}
          disabled={props.disabled === true}
          onClick={() => {
            setOpen(true)
          }}
        >
          {props.label ?? 'Add media'}
        </Button>
      </Group>
      {open ? (
        <MediaLibraryModal
          opened
          multiple
          selected={props.value}
          onClose={() => {
            setOpen(false)
          }}
          onPick={props.onChange}
        />
      ) : null}
    </div>
  )
}
