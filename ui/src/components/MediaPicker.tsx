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
import { IconMovie, IconMusic, IconPhoto, IconTypography, IconX } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { $api, useCanCreate } from '../api/client'
import type { paths } from '../api/schema'
import { uploadFile } from '../lib/upload'

export type Media = paths['/api/v1/media/{id}']['get']['responses'][200]['content']['application/json']
export type MediaKind = Media['kind']

// A hint for the file dialog only: the server decides what a file is from its bytes.
export const MEDIA_ACCEPT =
  'image/png,image/jpeg,image/webp,image/svg+xml,video/mp4,audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav,audio/ogg,font/woff2,font/ttf,font/otf,.mp3,.m4a,.wav,.ogg,.opus,.woff2,.ttf,.otf'
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
export const duration = (sec: number) => {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const KIND_LABEL: Record<MediaKind, string> = {
  image: 'Images',
  svg: 'SVG',
  video: 'Clips',
  audio: 'Audio',
  font: 'Fonts',
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
  const kinds = props.kinds ?? (['image', 'svg', 'video', 'audio', 'font'] as MediaKind[])
  const [filter, setFilter] = useState<'all' | MediaKind>('all')
  const [picked, setPicked] = useState<Media[]>(props.selected ?? [])
  const [uploading, setUploading] = useState(false)
  const canUpload = useCanCreate()
  const qc = useQueryClient()
  const list = $api.useQuery(
    'get',
    '/api/v1/media',
    { params: { query: { limit: 100, ...(kinds.length === 1 ? { kind: kinds[0] } : {}) } } },
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
  const upload = async (files: File[]) => {
    setUploading(true)
    for (const f of files) {
      try {
        await uploadFile(f)
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
    <Modal opened={props.opened} onClose={props.onClose} title={props.title ?? 'Add media'} size="xl">
      <Stack gap="md">
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
            <FileButton multiple accept={MEDIA_ACCEPT} onChange={(fs) => void upload(fs)}>
              {(p) => (
                <Button {...p} size="xs" variant="default" loading={uploading}>
                  Upload
                </Button>
              )}
            </FileButton>
          ) : null}
        </Group>
        {!list.isLoading && items.length === 0 ? (
          <Text size="sm" c="var(--va-muted)">
            {canUpload
              ? 'Nothing to pick yet. Upload a file here or on the Media page.'
              : 'Nothing to pick yet. Creators can upload on the Media page.'}
          </Text>
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
                  aria-label={`${m.filename}${m.caption ? `, ${m.caption}` : ''}`}
                  disabled={!ready}
                  onClick={() => {
                    toggle(m)
                  }}
                  data-testid={`pick-${m.id}`}
                >
                  <Thumb m={m} />
                  <Text size="xs" p={6} truncate title={m.filename}>
                    {m.filename}
                  </Text>
                </UnstyledButton>
              )
            })}
          </div>
        )}
        {props.multiple ? (
          <Group justify="space-between">
            <Text size="xs" c="var(--va-faint)">
              {picked.length} of up to {MAX_PICKS} picked
            </Text>
            <Button
              onClick={() => {
                props.onPick(picked)
                props.onClose()
              }}
            >
              Done
            </Button>
          </Group>
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
