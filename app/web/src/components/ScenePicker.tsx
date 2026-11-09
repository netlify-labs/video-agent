// Redo a scene (regenerate-beat plan §4.12): the shown version's scenes as chips to pick from, and the dialog that
// redoes some of them (Redo this part on a pinned comment). The version's beats come with it, or from GET …/beats for
// a version made before they were stored. The chips follow the server's rules (lib/scenes.ts pickable), each disabled
// one saying why.
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { $api, errorMessage, newIdempotencyKey, type Version, type Video } from '../api/client'
import { pickable, sceneChipLabel, type Beat } from '../lib/scenes'
import { clockTime, showError } from './bits'

/** Whether this deployment and this version let some of its scenes be redone on their own. */
export function useCanRedoScenes(v: Version | undefined): boolean {
  const config = $api.useQuery('get', '/api/v1/config')
  return (
    config.data?.features.includes('scoped_revision') === true &&
    v !== undefined &&
    v.status === 'ready' &&
    v.editable &&
    v.editing.capabilities.scopedRevision
  )
}

/** The version's scenes: from the DTO, else asked for once (when `enabled`). Null while loading or when it has none. */
export function useScenes(videoId: string, v: Version | undefined, enabled = true) {
  const fill = $api.useQuery(
    'get',
    '/api/v1/videos/{id}/versions/{n}/beats',
    { params: { path: { id: videoId, n: v?.n ?? 0 } } },
    { enabled: enabled && v !== undefined && v.beats === null && v.status === 'ready' && v.editable },
  )
  return {
    beats: v?.beats ?? fill.data?.beats ?? null,
    loading: fill.isLoading,
    error: fill.error ? errorMessage(fill.error) : null,
  }
}

export function ScenePicker(props: {
  videoId: string
  v: Version
  value: string[]
  onChange: (beats: string[]) => void
  disabled?: boolean
  /** A chip was hovered or focused (debounced): the page seeks its player to the scene. */
  onPreview?: (beat: Beat) => void
}) {
  const { beats, loading, error } = useScenes(props.videoId, props.v)
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preview = (beat: Beat | null) => {
    if (hover.current) clearTimeout(hover.current)
    hover.current = null
    const on = props.onPreview
    if (beat && on)
      hover.current = setTimeout(() => {
        on(beat)
      }, 150)
  }
  if (loading) return <Loader size="sm" />
  if (error)
    return (
      <Text size="sm" c="red">
        {error}
      </Text>
    )
  if (!beats?.length)
    return (
      <Text size="sm" c="var(--va-muted)">
        This version has no scenes to pick from. Revise the whole video instead.
      </Text>
    )
  const chips = pickable(beats, props.value)
  return (
    <Group gap={6} data-testid="scene-picker" role="group" aria-label="Scenes to redo">
      {chips.map(({ beat, picked, disabled }, i) => (
        <Tooltip key={beat.id} label={disabled} disabled={!disabled} multiline w={260}>
          <span
            onMouseEnter={() => {
              preview(beat)
            }}
            onMouseLeave={() => {
              preview(null)
            }}
            onFocus={() => {
              preview(beat)
            }}
          >
            <Chip
              size="sm"
              checked={picked}
              disabled={props.disabled || disabled !== null}
              onChange={(on) => {
                props.onChange(
                  on
                    ? chips.filter((c) => c.picked || c.beat.id === beat.id).map((c) => c.beat.id)
                    : props.value.filter((x) => x !== beat.id),
                )
              }}
            >
              {sceneChipLabel(i, beat)}
            </Chip>
          </span>
        </Tooltip>
      ))}
    </Group>
  )
}

/**
 * Redo some scenes of a version, in a dialog: the scenes (preselected), the comment that led here (checked), and what
 * should change. Nothing is sent until the button is pressed.
 */
export function RedoScenesModal({
  video,
  v,
  beats,
  comment,
  warning,
  onClose,
  onDone,
}: {
  video: Video
  v: Version
  /** The scenes picked to start with. */
  beats: string[]
  comment?: { id: string; body: string; timeSec: number | null }
  /** A warning above the picker (the editor's: a draft's changes aren't included). */
  warning?: string | null
  onClose: () => void
  /** After the revision is queued (default: just close). */
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState(beats)
  const [withComment, setWithComment] = useState(comment !== undefined)
  const [note, setNote] = useState('')
  const [key] = useState(newIdempotencyKey)
  const next = video.versions.length + 1
  const revise = $api.useMutation('post', '/api/v1/videos/{id}/versions', {
    onSuccess: () => {
      onClose()
      void qc.invalidateQueries()
      notifications.show({ color: 'teal', message: `Making v${next}: redoing the scenes you picked.` })
      onDone?.()
    },
    onError: showError,
  })
  const sendComment = comment !== undefined && withComment
  return (
    <Modal opened onClose={onClose} size="lg" title={`Redo part of v${v.n}`}>
      <Stack gap="sm">
        {warning ? (
          <Alert color="yellow" variant="light" data-testid="redo-warning">
            {warning}
          </Alert>
        ) : null}
        <ScenePicker videoId={video.id} v={v} value={picked} onChange={setPicked} />
        {comment ? (
          <Checkbox
            checked={withComment}
            onChange={(e) => {
              setWithComment(e.currentTarget.checked)
            }}
            label={
              <>
                <Text size="xs" c="var(--va-faint)">
                  The comment{comment.timeSec !== null ? ` at ${clockTime(comment.timeSec)}` : ''}
                </Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {comment.body}
                </Text>
              </>
            }
          />
        ) : null}
        <Textarea
          label={sendComment ? 'Anything else the agent should know? (optional)' : 'What should change?'}
          autosize
          minRows={3}
          maxLength={2000}
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value)
          }}
        />
        <Text size="sm" c="var(--va-faint)">
          Everything else stays as it is in v{v.n}, and so do length, sound and voice. Say in the request if a
          scene should run longer.
        </Text>
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={revise.isPending}
            disabled={picked.length === 0 || (!sendComment && note.trim().length < 3)}
            onClick={() => {
              revise.mutate({
                params: { path: { id: video.id }, header: { 'idempotency-key': key } },
                body: {
                  prompt: note.trim().length >= 3 ? note.trim() : 'Incorporate the feedback below.',
                  fromVersion: v.n,
                  scope: { beats: picked },
                  ...(sendComment ? { commentIds: [comment.id] } : {}),
                },
              })
            }}
          >
            Make v{next}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
