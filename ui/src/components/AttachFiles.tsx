// Attaching files where people write (a comment, a revision request): an Attach button that opens the media library
// (pick, or upload from there), and a drop target around the text box that uploads dropped files straight to the
// library and attaches them once they're checked.
import { Button, Group, Loader } from '@mantine/core'
import { useQueryClient } from '@tanstack/react-query'
import { IconPaperclip } from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'
import { uploadFile, waitReady } from '../lib/upload'
import { MediaLibraryModal, type Media } from './MediaPicker'

interface Pending {
  key: string
  name: string
  error: string | null
}

/** Uploads files to the library and hands each one over once it's ready; `pending` lists the ones on their way. */
export function useAttachUploads(onReady: (m: Media) => void) {
  const qc = useQueryClient()
  const [pending, setPending] = useState<Pending[]>([])
  const add = async (files: File[]) => {
    await Promise.all(
      files.map(async (f) => {
        const key = crypto.randomUUID()
        setPending((p) => [...p, { key, name: f.name, error: null }])
        try {
          const id = await uploadFile(f)
          const m = await waitReady(id)
          onReady(m)
          setPending((p) => p.filter((x) => x.key !== key))
        } catch (e) {
          const error = e instanceof Error ? e.message : "The file couldn't be uploaded."
          setPending((p) => p.map((x) => (x.key === key ? { ...x, error } : x)))
        }
      }),
    )
    void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[1]).startsWith('/api/v1/media') })
  }
  const dismiss = (key: string) => {
    setPending((p) => p.filter((x) => x.key !== key))
  }
  return { pending, add, dismiss }
}

/** Files on their way (or that failed), under the box they were dropped on. */
export function PendingUploads({
  pending,
  onDismiss,
}: {
  pending: Pending[]
  onDismiss: (key: string) => void
}) {
  if (!pending.length) return null
  return (
    <Group gap={6} data-testid="pending-uploads">
      {pending.map((p) => (
        <span key={p.key} className="va-media-chip" data-error={p.error ? true : undefined}>
          {p.error ? null : <Loader size={12} color="var(--va-accent)" />}
          <span className="va-media-chip-name">
            {p.error ? `${p.name}: ${p.error}` : `Uploading ${p.name}…`}
          </span>
          {p.error ? (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => {
                onDismiss(p.key)
              }}
            >
              Dismiss
            </Button>
          ) : null}
        </span>
      ))}
    </Group>
  )
}

/** A box that takes dropped files: it lights up while files are over it. */
export function DropTarget({
  onFiles,
  disabled,
  children,
  label = 'Drop to attach',
}: {
  onFiles: (files: File[]) => void
  disabled?: boolean
  children: ReactNode
  label?: string
}) {
  const [over, setOver] = useState(false)
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files')
  return (
    <div
      className="va-drop-target"
      data-over={over || undefined}
      data-label={label}
      onDragOver={(e) => {
        if (disabled || !hasFiles(e)) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        if (disabled || !hasFiles(e)) return
        e.preventDefault()
        setOver(false)
        const files = [...e.dataTransfer.files]
        if (files.length) onFiles(files)
      }}
    >
      {children}
    </div>
  )
}

/** Attach files: opens the media library to pick (or upload) items, added to `value`. */
export function AttachButton({
  value,
  onChange,
  disabled,
  label = 'Attach files',
  max,
}: {
  value: Media[]
  onChange: (items: Media[]) => void
  disabled?: boolean
  label?: string
  max?: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconPaperclip size={14} />}
        disabled={disabled === true}
        onClick={() => {
          setOpen(true)
        }}
      >
        {label}
      </Button>
      {open ? (
        <MediaLibraryModal
          opened
          multiple
          selected={value}
          onClose={() => {
            setOpen(false)
          }}
          onPick={(items) => {
            onChange(max ? items.slice(0, max) : items)
          }}
        />
      ) : null}
    </>
  )
}
