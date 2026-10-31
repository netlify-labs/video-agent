// Review on a ready version (plan v2 §5): pinned comments, markers, approvals. A pin is a moment (timeSec) and,
// optionally, a spot (x/y, 0–1 within the displayed video, letterboxing excluded). Pins show on their own version
// only: as markers under the player and as dots on the frame around their moment.
import { ActionIcon, Badge, Button, Card, Group, Menu, Stack, Text, Textarea, Tooltip } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { IconCheck, IconDots, IconMapPin, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { $api, errorMessage, type Version, type Video } from '../api/client'
import type { paths } from '../api/schema'
import { fileUrl, relativeTime } from './bits'

type Comment =
  paths['/api/v1/videos/{id}/comments']['get']['responses'][200]['content']['application/json']['items'][number]
export interface Pin {
  timeSec: number
  x: number | null
  y: number | null
}

/** Dots stay on the frame this long around their moment. */
const DOT_WINDOW_SEC = 1

/** Where the picture sits inside the element: object-fit: contain letterboxes it. */
export function contentBox(el: { width: number; height: number }, video: { width: number; height: number }) {
  if (!video.width || !video.height) return { left: 0, top: 0, width: el.width, height: el.height }
  const scale = Math.min(el.width / video.width, el.height / video.height)
  const width = video.width * scale
  const height = video.height * scale
  return { left: (el.width - width) / 2, top: (el.height - height) / 2, width, height }
}

export function clockTime(sec: number) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

function useComments(videoId: string) {
  return $api.useQuery('get', '/api/v1/videos/{id}/comments', {
    params: { path: { id: videoId }, query: { limit: 200 } },
  })
}

export function ReviewPlayer({
  video,
  v,
  player,
  picking,
  pending,
  onPick,
}: {
  video: Video
  v: Version
  player: RefObject<HTMLVideoElement | null>
  picking: boolean
  pending: Pin | null
  onPick: (x: number, y: number) => void
}) {
  const comments = useComments(video.id)
  const [now, setNow] = useState(0)
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const wrap = useRef<HTMLDivElement>(null)
  const pins = (comments.data?.items ?? []).filter((c) => c.versionN === v.n && c.timeSec !== null)
  const length = v.output?.durationSec ?? 0

  useEffect(() => {
    const el = player.current
    const w = wrap.current
    if (!el || !w) return
    const measure = () => {
      setBox(
        contentBox(
          { width: w.clientWidth, height: w.clientHeight },
          { width: el.videoWidth || v.output?.width || 0, height: el.videoHeight || v.output?.height || 0 },
        ),
      )
    }
    const tick = () => {
      setNow(el.currentTime)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(w)
    el.addEventListener('loadedmetadata', measure)
    el.addEventListener('timeupdate', tick)
    el.addEventListener('seeked', tick)
    return () => {
      ro.disconnect()
      el.removeEventListener('loadedmetadata', measure)
      el.removeEventListener('timeupdate', tick)
      el.removeEventListener('seeked', tick)
    }
  }, [player, v.n, v.output?.width, v.output?.height])

  const dots = pins.filter(
    (c) => c.x !== null && c.y !== null && Math.abs((c.timeSec ?? 0) - now) <= DOT_WINDOW_SEC,
  )
  const dotStyle = (x: number, y: number) => ({
    left: box.left + x * box.width,
    top: box.top + y * box.height,
  })

  return (
    <div>
      <div ref={wrap} className="va-review-frame">
        <video
          ref={player}
          key={`${video.id}-${v.n}`}
          controls={!picking}
          playsInline
          poster={fileUrl(video.id, v.n, 'poster')}
          src={fileUrl(video.id, v.n, 'video')}
        >
          <track kind="captions" src={fileUrl(video.id, v.n, 'captions')} srcLang="en" label="Captions" />
        </video>
        {dots.map((c) => (
          <Tooltip
            key={c.id}
            label={`${c.author.name ?? c.author.email ?? ''}: ${c.body}`}
            multiline
            maw={260}
          >
            <span className="va-pin-dot" style={dotStyle(c.x ?? 0, c.y ?? 0)} data-testid="pin-dot" />
          </Tooltip>
        ))}
        {pending && pending.x !== null && pending.y !== null ? (
          <span className="va-pin-dot va-pin-dot-pending" style={dotStyle(pending.x, pending.y)} />
        ) : null}
        {picking ? (
          <div
            className="va-pin-capture"
            role="button"
            tabIndex={0}
            aria-label="Click the frame to mark a spot"
            data-testid="pin-capture"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - r.left - box.left) / box.width
              const y = (e.clientY - r.top - box.top) / box.height
              // Clicks on the letterbox bars don't count.
              if (x < 0 || x > 1 || y < 0 || y > 1) return
              onPick(Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000)
            }}
            onKeyDown={() => undefined}
          >
            <span className="va-pin-hint">Click the frame to mark a spot, or just write your comment</span>
          </div>
        ) : null}
      </div>
      {length > 0 && pins.length > 0 ? (
        <div className="va-markers" aria-label="Comment markers">
          {pins.map((c) => (
            <Tooltip key={c.id} label={`${clockTime(c.timeSec ?? 0)} · ${c.body}`} multiline maw={260}>
              <button
                type="button"
                className="va-marker"
                data-resolved={c.resolvedAt ? 'true' : undefined}
                style={{ left: `${Math.min(100, ((c.timeSec ?? 0) / length) * 100)}%` }}
                aria-label={`Comment at ${clockTime(c.timeSec ?? 0)}`}
                onClick={() => {
                  const el = player.current
                  if (!el) return
                  el.pause()
                  el.currentTime = c.timeSec ?? 0
                }}
              />
            </Tooltip>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Approve / Request changes. Hidden from the version's author and from viewers; counts show for everyone. */
export function VerdictBar({ video, v, canReview }: { video: Video; v: Version; canReview: boolean }) {
  const qc = useQueryClient()
  const set = $api.useMutation('put', '/api/v1/videos/{id}/versions/{n}/verdict', {
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  })
  const { approved, changesRequested, mine } = v.verdicts
  if (!canReview && !approved && !changesRequested) return null
  const ask = (verdict: 'approved' | 'changes_requested') => {
    if (mine === verdict) {
      set.mutate({ params: { path: { id: video.id, n: v.n } }, body: { verdict: null } })
      return
    }
    let note = ''
    modals.openConfirmModal({
      title: verdict === 'approved' ? `Approve v${v.n}` : `Request changes on v${v.n}`,
      children: (
        <Textarea
          label="Note (optional)"
          autosize
          minRows={2}
          maxLength={500}
          data-autofocus
          onChange={(e) => {
            note = e.currentTarget.value
          }}
        />
      ),
      labels: { confirm: verdict === 'approved' ? 'Approve' : 'Request changes', cancel: 'Cancel' },
      onConfirm: () => {
        set.mutate({
          params: { path: { id: video.id, n: v.n } },
          body: { verdict, ...(note.trim() ? { note: note.trim() } : {}) },
        })
      },
    })
  }
  return (
    <Group justify="space-between" gap="sm" className="va-verdicts">
      <Group gap={6}>
        {approved ? (
          <Badge variant="light" color="teal" leftSection={<IconCheck size={12} />}>
            {approved} approved
          </Badge>
        ) : null}
        {changesRequested ? (
          <Badge variant="light" color="orange">
            {changesRequested} want changes
          </Badge>
        ) : null}
      </Group>
      {canReview ? (
        <Group gap="xs">
          <Button
            size="xs"
            variant={mine === 'approved' ? 'filled' : 'default'}
            loading={set.isPending}
            onClick={() => {
              ask('approved')
            }}
          >
            {mine === 'approved' ? 'Approved' : 'Approve'}
          </Button>
          <Button
            size="xs"
            variant={mine === 'changes_requested' ? 'filled' : 'default'}
            loading={set.isPending}
            onClick={() => {
              ask('changes_requested')
            }}
          >
            {mine === 'changes_requested' ? 'Changes requested' : 'Request changes'}
          </Button>
        </Group>
      ) : null}
    </Group>
  )
}

export function CommentsCard({
  video,
  v,
  player,
  canComment,
  picking,
  setPicking,
  pending,
  setPending,
}: {
  video: Video
  v: Version
  player: RefObject<HTMLVideoElement | null>
  canComment: boolean
  picking: boolean
  setPicking: (on: boolean) => void
  pending: Pin | null
  setPending: (p: Pin | null) => void
}) {
  const qc = useQueryClient()
  const comments = useComments(video.id)
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const refresh = () => void qc.invalidateQueries()
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorMessage(e) })
  const add = $api.useMutation('post', '/api/v1/videos/{id}/comments', {
    onSuccess: () => {
      setBody('')
      setPending(null)
      setPicking(false)
      refresh()
    },
    onError,
  })
  const patch = $api.useMutation('patch', '/api/v1/comments/{id}', {
    onSuccess: () => {
      setEditing(null)
      refresh()
    },
    onError,
  })
  const remove = $api.useMutation('delete', '/api/v1/comments/{id}', { onSuccess: refresh, onError })
  const read = $api.useMutation('post', '/api/v1/videos/{id}/comments/read', { onSuccess: refresh })

  // Opening the video reads its comments.
  const unread = comments.data?.unreadCount ?? 0
  useEffect(() => {
    if (unread > 0 && !read.isPending) read.mutate({ params: { path: { id: video.id } }, body: {} })
    // Only when the count changes.
  }, [unread, video.id])

  const items = (comments.data?.items ?? []).filter((c) => c.versionN === v.n)
  const ready = v.status === 'ready'
  const startPin = () => {
    const el = player.current
    if (!el) return
    el.pause()
    setPending({ timeSec: Math.round(el.currentTime * 10) / 10, x: null, y: null })
    setPicking(true)
  }
  const seek = (c: Comment) => {
    const el = player.current
    if (!el || c.timeSec === null) return
    el.pause()
    el.currentTime = c.timeSec
  }

  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Comments on v{v.n}</Text>
        <Text size="sm" c="var(--va-faint)" className="num">
          {items.length}
        </Text>
      </Group>
      <Stack gap="sm">
        {items.length === 0 ? (
          <Text size="sm" c="var(--va-faint)">
            {canComment
              ? ready
                ? 'No comments yet. Pause where something should change and pin a comment there.'
                : 'No comments yet.'
              : 'No comments yet.'}
          </Text>
        ) : null}
        {items.map((c) => (
          <div key={c.id} className="va-comment" data-resolved={c.resolvedAt ? 'true' : undefined}>
            <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
              <div style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6}>
                  <Text size="sm" fw={600}>
                    {c.author.name ?? c.author.email?.split('@')[0]}
                  </Text>
                  {c.timeSec !== null ? (
                    <button type="button" className="va-comment-time num" onClick={() => seek(c)}>
                      {c.x !== null ? <IconMapPin size={12} /> : null}
                      {clockTime(c.timeSec)}
                    </button>
                  ) : null}
                  <Text size="xs" c="var(--va-faint)">
                    {relativeTime(c.createdAt)}
                    {c.editedAt ? ' · edited' : ''}
                  </Text>
                  {c.resolvedAt ? (
                    <Badge size="xs" variant="light" color="gray">
                      Resolved
                    </Badge>
                  ) : null}
                  {c.addressedInN ? (
                    <Badge size="xs" variant="light" color="teal">
                      Addressed in v{c.addressedInN}
                    </Badge>
                  ) : null}
                </Group>
                {editing?.id === c.id ? (
                  <Stack gap={6} mt={4}>
                    <Textarea
                      autosize
                      minRows={2}
                      maxLength={2000}
                      value={editing.body}
                      aria-label="Edit comment"
                      onChange={(e) => {
                        setEditing({ id: c.id, body: e.currentTarget.value })
                      }}
                    />
                    <Group gap="xs">
                      <Button
                        size="xs"
                        loading={patch.isPending}
                        disabled={!editing.body.trim()}
                        onClick={() => {
                          patch.mutate({ params: { path: { id: c.id } }, body: { body: editing.body } })
                        }}
                      >
                        Save
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        color="gray"
                        onClick={() => {
                          setEditing(null)
                        }}
                      >
                        Cancel
                      </Button>
                    </Group>
                  </Stack>
                ) : (
                  <Text
                    size="sm"
                    c="var(--va-muted)"
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {c.body}
                  </Text>
                )}
              </div>
              {c.can.edit || c.can.delete || c.can.resolve ? (
                <Menu position="bottom-end">
                  <Menu.Target>
                    <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Comment actions">
                      <IconDots size={14} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {c.can.resolve ? (
                      <Menu.Item
                        onClick={() => {
                          patch.mutate({ params: { path: { id: c.id } }, body: { resolved: !c.resolvedAt } })
                        }}
                      >
                        {c.resolvedAt ? 'Reopen' : 'Resolve'}
                      </Menu.Item>
                    ) : null}
                    {c.can.edit ? (
                      <Menu.Item
                        onClick={() => {
                          setEditing({ id: c.id, body: c.body })
                        }}
                      >
                        Edit
                      </Menu.Item>
                    ) : null}
                    {c.can.delete ? (
                      <Menu.Item
                        color="red"
                        onClick={() => {
                          remove.mutate({ params: { path: { id: c.id } } })
                        }}
                      >
                        Delete
                      </Menu.Item>
                    ) : null}
                  </Menu.Dropdown>
                </Menu>
              ) : null}
            </Group>
          </div>
        ))}

        {canComment ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              add.mutate({
                params: { path: { id: video.id } },
                body: {
                  versionN: v.n,
                  body,
                  ...(pending ? { timeSec: pending.timeSec, x: pending.x, y: pending.y } : {}),
                },
              })
            }}
          >
            <Stack gap="xs">
              <Textarea
                aria-label="Add a comment"
                placeholder="Add a comment…"
                autosize
                minRows={2}
                maxLength={2000}
                value={body}
                onChange={(e) => {
                  setBody(e.currentTarget.value)
                }}
              />
              <Group justify="space-between" gap="xs">
                {pending ? (
                  <Badge
                    variant="light"
                    size="lg"
                    leftSection={<IconMapPin size={14} />}
                    rightSection={
                      <ActionIcon
                        size="xs"
                        variant="transparent"
                        color="gray"
                        aria-label="Remove the pin"
                        onClick={() => {
                          setPending(null)
                          setPicking(false)
                        }}
                      >
                        <IconX size={12} />
                      </ActionIcon>
                    }
                  >
                    {clockTime(pending.timeSec)}
                    {pending.x !== null ? ' · spot marked' : picking ? ' · click the frame' : ''}
                  </Badge>
                ) : ready ? (
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconMapPin size={14} />}
                    onClick={startPin}
                  >
                    Pin to this moment
                  </Button>
                ) : (
                  <span />
                )}
                <Button type="submit" size="xs" loading={add.isPending} disabled={!body.trim()}>
                  Comment
                </Button>
              </Group>
            </Stack>
          </form>
        ) : null}
      </Stack>
    </Card>
  )
}
