import { ActionIcon, Badge, CopyButton, Group, Text, TextInput, Tooltip } from '@mantine/core'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import type { Video } from '../api/client'

const STATUS: Record<Video['status'], { color: string; label: string }> = {
  queued: { color: 'gray', label: 'Queued' },
  running: { color: 'blue', label: 'Making' },
  finishing: { color: 'cyan', label: 'Saving' },
  ready: { color: 'green', label: 'Ready' },
  failed: { color: 'red', label: 'Failed' },
  cancelled: { color: 'gray', label: 'Cancelled' },
  timed_out: { color: 'orange', label: 'Timed out' },
}

export function StatusBadge({ status }: { status: Video['status'] }) {
  const s = STATUS[status]
  return (
    <Badge color={s.color} variant="light" size="sm">
      {s.label}
    </Badge>
  )
}

export const inProgress = (s: Video['status']) => s === 'queued' || s === 'running' || s === 'finishing'

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
              <ActionIcon variant="subtle" color={copied ? 'green' : 'gray'} onClick={copy} aria-label={`Copy ${label}`}>
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
  if (sec === null || sec === undefined) return ''
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

export function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Group gap={6} wrap="nowrap" align="baseline">
      <Text size="sm" c="dimmed" w={110} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text size="sm" style={{ wordBreak: 'break-word' }}>
        {children}
      </Text>
    </Group>
  )
}

export const fileUrl = (videoId: string, n: number, file: 'video' | 'poster' | 'gif' | 'captions', download = false) =>
  `/api/v1/videos/${videoId}/versions/${n}/${file}${download ? '?download=1' : ''}`
