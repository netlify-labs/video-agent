import { ActionIcon, CopyButton, Group, Text, TextInput, Tooltip } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import { useState } from 'react'
import { errorMessage, type Version, type Video } from '../api/client'
import { mockFile } from '../mock/files'

export const STATUS_WORD: Record<Video['status'], string> = {
  queued: 'Queued',
  running: 'Making',
  finishing: 'Saving',
  ready: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
}

/** Shows a failed request's message as a red toast. */
export const showError = (e: unknown) => notifications.show({ color: 'red', message: errorMessage(e) })

/** Asks before something that can't be taken back, with a red confirm button. */
export function confirmDanger(o: {
  title: string
  body: string
  confirm: string
  cancel?: string
  onConfirm: () => void
}) {
  modals.openConfirmModal({
    title: o.title,
    children: <Text size="sm">{o.body}</Text>,
    labels: { confirm: o.confirm, cancel: o.cancel ?? 'Cancel' },
    confirmProps: { color: 'red', variant: 'light' },
    onConfirm: o.onConfirm,
  })
}

export const inProgress = (s: Video['status']) => s === 'queued' || s === 'running' || s === 'finishing'

/** A status as a dot and a word: the dot carries the data hue only when it's ready or working. */
export function Status({ status, size = 'sm' }: { status: Video['status']; size?: 'xs' | 'sm' }) {
  const state =
    status === 'ready'
      ? 'ready'
      : inProgress(status)
        ? 'working'
        : status === 'failed' || status === 'timed_out'
          ? 'failed'
          : 'idle'
  return (
    <Group gap={6} wrap="nowrap">
      <span className="va-dot" data-state={state} aria-hidden />
      <Text size={size} c={state === 'failed' ? 'var(--va-negative)' : 'var(--va-muted)'}>
        {STATUS_WORD[status]}
      </Text>
    </Group>
  )
}

/** The product's mark: a frame with a play notch, in the brand hue. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="4" fill="var(--va-accent)" />
      <path d="M10 8.5v7l6-3.5z" fill="var(--va-ground)" />
    </svg>
  )
}

/** The badge that opens the story of how this app was built on Agent Runners (static/how-we-built-it): at the foot
 * of the sidebar in the app, in the corner on pages without one. */
export function PoweredBy({ inSidebar = false }: { inSidebar?: boolean }) {
  return (
    <a
      className={inSidebar ? 'va-powered va-powered-sidebar' : 'va-powered'}
      href="/how-we-built-it/"
      target="_blank"
      rel="noreferrer"
      title="How we built Video Agent"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path d="M12 2 2 12l10 10 10-10z" fill="var(--va-accent)" />
      </svg>
      Powered by Netlify Agent Runners
    </a>
  )
}

export function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <TextInput
      label={label}
      value={value}
      readOnly
      onFocus={(e) => {
        e.currentTarget.select()
      }}
      rightSection={
        <CopyButton value={value} timeout={1500}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy'}>
              <ActionIcon variant="subtle" color="gray" onClick={copy} aria-label={`Copy ${label}`}>
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      }
    />
  )
}

export function relativeTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString()
}

export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s.toFixed(0)} s`
}

/** 95.7 → "1:35" (whole seconds, rounded down). */
export function clockTime(sec: number) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

export function credits(v: number | undefined | null): string {
  return v === undefined || v === null ? '—' : v.toFixed(0)
}

export function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Group gap={12} wrap="nowrap" align="baseline" justify="space-between">
      <Text size="sm" c="var(--va-muted)" style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text size="sm" ta="right" className="num" style={{ wordBreak: 'break-word' }}>
        {children}
      </Text>
    </Group>
  )
}

export const fileUrl = (
  videoId: string,
  n: number,
  file: 'video' | 'poster' | 'gif' | 'captions' | 'narration-audio' | 'transcript',
  download = false,
) =>
  // Narration's downloads have no mock asset: the mock API answers their routes.
  import.meta.env.VITE_MOCK && file !== 'narration-audio' && file !== 'transcript'
    ? mockFile(videoId, file)
    : `/api/v1/videos/${videoId}/versions/${n}/${file}${download ? '?download=1' : ''}`

/** The captions track: a corrected version's names its revision, so the player loads the new file. */
export const captionsUrl = (videoId: string, v: { n: number; captions: { rev: number } | null }) =>
  v.captions?.rev
    ? `/api/v1/videos/${videoId}/versions/${v.n}/captions?rev=${v.captions.rev}`
    : fileUrl(videoId, v.n, 'captions')

/** A signed URL from the DTO as a same-origin path, like the redirect gives. */
export const localUrl = (signed: string) => {
  const u = new URL(signed, window.location.origin)
  return u.pathname + u.search
}

/** A version's poster or GIF straight from the signed URL in its DTO: no redirect, and stable enough for the browser
 * cache. */
export const imageUrl = (videoId: string, v: Version, file: 'poster' | 'gif') => {
  const signed = import.meta.env.VITE_MOCK ? null : v.files?.[file]
  return signed ? localUrl(signed) : fileUrl(videoId, v.n, file)
}

const localSrcset = (srcset: string) =>
  srcset
    .split(', ')
    .map((part) => {
      const [url = '', w = ''] = part.split(' ')
      return `${localUrl(url)} ${w}`
    })
    .join(', ')

/**
 * The version image, falling back once to the redirect if its signed URL expired on a page left open. A poster uses
 * the small AVIF/WebP variants picked by `sizes` (the JPEG stays the fallback) and shows the tiny blurred placeholder
 * until it decodes, for versions that have them.
 */
export function VersionImage({
  videoId,
  v,
  file,
  sizes,
  priority = false,
}: {
  videoId: string
  v: Version
  file: 'poster' | 'gif'
  sizes?: string
  /** Above the fold (the library's first row): fetched at once and first, instead of lazily. */
  priority?: boolean
}) {
  const [fallback, setFallback] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const sources = file === 'poster' && sizes && !fallback ? (v.files?.posterSources ?? []) : []
  const lqip = file === 'poster' && !loaded ? v.files?.lqip : undefined
  const img = (
    <img
      src={fallback ? fileUrl(videoId, v.n, file) : imageUrl(videoId, v, file)}
      alt=""
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      className={lqip ? 'va-lqip' : undefined}
      style={lqip ? { backgroundImage: `url("${lqip}")` } : undefined}
      onLoad={() => {
        setLoaded(true)
      }}
      onError={() => {
        setFallback(true)
      }}
    />
  )
  if (!sources.length) return img
  return (
    <picture>
      {sources.map((s) => (
        <source key={s.type} type={s.type} srcSet={localSrcset(s.srcset)} sizes={sizes} />
      ))}
      {img}
    </picture>
  )
}
