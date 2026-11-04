// Review on a ready version (plan v2 §5): pinned comments, markers, approvals. A pin is a moment (timeSec) and,
// optionally, a spot (x/y, 0–1 within the displayed video, letterboxing excluded). Pins show on their own version
// only: as markers under the player and as dots on the frame around their moment.
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Kbd,
  Menu,
  Modal,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { IconCheck, IconDots, IconMapPin, IconSparkles, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { $api, commentsInit, newIdempotencyKey, type Version, type Video } from '../api/client'
import type { paths } from '../api/schema'
import { captionsUrl, clockTime, fileUrl, imageUrl, relativeTime, showError, useAfterWrite } from './bits'

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

function useComments(videoId: string) {
  return $api.useQuery('get', '/api/v1/videos/{id}/comments', commentsInit(videoId))
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
          poster={imageUrl(video.id, v, 'poster')}
          src={fileUrl(video.id, v.n, 'video')}
        >
          <track
            key={v.captions?.rev ?? 0}
            kind="captions"
            src={captionsUrl(video.id, v)}
            srcLang="en"
            label="Captions"
          />
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
  const afterWrite = useAfterWrite()
  const set = $api.useMutation('put', '/api/v1/videos/{id}/versions/{n}/verdict', afterWrite)
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

/**
 * Incorporate feedback (plan v2 §5): every open comment on this version, all checked, plus an optional note. Makes
 * the next version from this one with those comments; they count as addressed once it succeeds.
 */
function IncorporateModal({
  video,
  v,
  open,
  comments,
  onClose,
}: {
  video: Video
  v: Version
  open: Comment[]
  comments: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<string[]>(() => open.map((c) => c.id))
  const [note, setNote] = useState('')
  const [key] = useState(newIdempotencyKey)
  const revise = $api.useMutation('post', '/api/v1/videos/{id}/versions', {
    onSuccess: () => {
      onClose()
      void qc.invalidateQueries()
      notifications.show({
        color: 'teal',
        message: `Making v${video.versions.length + 1} with the feedback.`,
      })
    },
    onError: showError,
  })
  return (
    <Modal
      opened={comments}
      onClose={onClose}
      title={`Incorporate feedback into v${video.versions.length + 1}`}
    >
      <Stack gap="sm">
        <Text size="sm" c="var(--va-muted)">
          The agent starts from v{v.n} and works through the comments you leave checked. Pinned comments come
          with a still of that moment.
        </Text>
        <Checkbox.Group value={picked} onChange={setPicked}>
          <Stack gap={8}>
            {open.map((c) => (
              <Checkbox
                key={c.id}
                value={c.id}
                label={
                  <Text size="sm">
                    <b>{c.author.name ?? c.author.email?.split('@')[0]}</b>
                    {c.timeSec !== null ? ` · ${clockTime(c.timeSec)}` : ''}: {c.body}
                  </Text>
                }
              />
            ))}
          </Stack>
        </Checkbox.Group>
        <Textarea
          label="Note for the agent (optional)"
          placeholder='For example: "ignore the colour comments"'
          autosize
          minRows={2}
          maxLength={2000}
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value)
          }}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={revise.isPending}
            disabled={picked.length === 0}
            onClick={() => {
              revise.mutate({
                params: { path: { id: video.id }, header: { 'idempotency-key': key } },
                body: {
                  prompt: note.trim().length >= 3 ? note.trim() : 'Incorporate the feedback below.',
                  fromVersion: v.n,
                  commentIds: picked,
                },
              })
            }}
          >
            Make v{video.versions.length + 1} ({picked.length})
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

/** A note waiting to be posted with the others. */
interface Draft {
  key: string
  body: string
  timeSec: number | null
  x: number | null
  y: number | null
}

export function CommentsCard({
  video,
  v,
  player,
  canComment,
  canIncorporate,
  busy,
  picking,
  setPicking,
  pending,
  setPending,
}: {
  video: Video
  v: Version
  player: RefObject<HTMLVideoElement | null>
  canComment: boolean
  /** The owner or an admin, with Creator powers. */
  canIncorporate: boolean
  /** Another version is in progress. */
  busy: boolean
  picking: boolean
  setPicking: (on: boolean) => void
  pending: Pin | null
  setPending: (p: Pin | null) => void
}) {
  const [incorporating, setIncorporating] = useState(false)
  const qc = useQueryClient()
  const comments = useComments(video.id)
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const refresh = () => void qc.invalidateQueries()
  const add = $api.useMutation('post', '/api/v1/videos/{id}/comments', {
    onSuccess: () => {
      setBody('')
      setPending(null)
      setPicking(false)
      refresh()
    },
    onError: showError,
  })
  const patch = $api.useMutation('patch', '/api/v1/comments/{id}', {
    onSuccess: () => {
      setEditing(null)
      refresh()
    },
    onError: showError,
  })
  const remove = $api.useMutation('delete', '/api/v1/comments/{id}', {
    onSuccess: refresh,
    onError: showError,
  })
  // Reading changes only unread counts (comments, videos, the bell), not the account, usage or config.
  const read = $api.useMutation('post', '/api/v1/videos/{id}/comments/read', {
    onSuccess: () =>
      void qc.invalidateQueries({
        predicate: (q) => /^\/api\/v1\/(videos|notifications)/.test(String(q.queryKey[1])),
      }),
  })

  // Opening the video reads its comments.
  const unread = comments.data?.unreadCount ?? 0
  useEffect(() => {
    if (unread > 0 && !read.isPending) read.mutate({ params: { path: { id: video.id } }, body: {} })
    // Only when the count changes.
  }, [unread, video.id])

  const items = (comments.data?.items ?? []).filter((c) => c.versionN === v.n)
  const ready = v.status === 'ready'
  const open = items.filter((c) => !c.resolvedAt)
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

  // A pass through the video: notes at moments (C), each with an optional spot, posted together as one block.
  const [drafts, setDrafts] = useState<Draft[]>([])
  const composer = useRef<HTMLTextAreaElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const addBatch = $api.useMutation('post', '/api/v1/videos/{id}/comments/batch', {
    onSuccess: () => {
      setBody('')
      setDrafts([])
      setPending(null)
      setPicking(false)
      refresh()
    },
    onError: showError,
  })
  /** Moves the note being written into the draft list. False when there's nothing to move. */
  const stash = () => {
    if (!body.trim()) return false
    setDrafts((d) => [...d, { key: crypto.randomUUID(), body: body.trim(), ...pinOf(pending) }])
    setBody('')
    setPending(null)
    setPicking(false)
    return true
  }
  const stashRef = useRef(stash)
  stashRef.current = stash
  // C: pause and start a note at this moment (the one being written, if it has text, becomes a note first).
  useEffect(() => {
    if (!canComment || !ready) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'c' && e.key !== 'C') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const t = e.target as Element | null
      if (
        t?.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
        )
      )
        return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      const el = player.current
      if (!el || el.closest('[hidden]')) return
      e.preventDefault()
      stashRef.current()
      el.pause()
      setPending({ timeSec: Math.round(el.currentTime * 10) / 10, x: null, y: null })
      setPicking(false)
      composer.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [canComment, ready, player, setPending, setPicking])

  // A moment with nothing written (C pressed by mistake, or changed your mind) lets go when the video plays again,
  // so the next C notes the new moment. A marked spot keeps it: that was on purpose.
  const loose = useRef(false)
  loose.current = pending !== null && pending.x === null && !body.trim()
  useEffect(() => {
    const onPlay = (e: Event) => {
      if (e.target !== player.current || !loose.current) return
      setPending(null)
      setPicking(false)
      if (document.activeElement === composer.current) form.current?.focus()
    }
    document.addEventListener('play', onPlay, true)
    return () => {
      document.removeEventListener('play', onPlay, true)
    }
  }, [player, setPending, setPicking])

  /** A note's moment, as a button that jumps the player there. */
  const timeButton = (t: number, spot: boolean, label?: string) => (
    <button
      type="button"
      className="va-comment-time num"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        const el = player.current
        if (!el) return
        el.pause()
        el.currentTime = t
      }}
    >
      {spot ? <IconMapPin size={12} /> : null}
      {clockTime(t)}
    </button>
  )

  /** One comment's line: its moment, badges, text (or editor) and actions. A timed one seeks when clicked. */
  const note = (c: Comment, head: boolean) => (
    <div
      key={c.id}
      className="va-comment"
      data-resolved={c.resolvedAt ? 'true' : undefined}
      data-timed={c.timeSec !== null ? 'true' : undefined}
      data-testid="comment"
      onClick={(e) => {
        if (c.timeSec === null || editing?.id === c.id) return
        // Buttons, menus and text selection keep their own clicks.
        if ((e.target as Element).closest('button, a, textarea, [role="menu"]')) return
        if (window.getSelection()?.toString()) return
        seek(c)
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6}>
            {head ? (
              <Text size="sm" fw={600}>
                {c.author.name ?? c.author.email?.split('@')[0]}
              </Text>
            ) : null}
            {c.timeSec !== null ? timeButton(c.timeSec, c.x !== null) : null}
            {head ? (
              <Text size="xs" c="var(--va-faint)">
                {relativeTime(c.createdAt)}
                {c.editedAt ? ' · edited' : ''}
              </Text>
            ) : c.editedAt ? (
              <Text size="xs" c="var(--va-faint)">
                edited
              </Text>
            ) : null}
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
            <Text size="sm" c="var(--va-muted)" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
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
  )

  // Notes posted together show as one block (one author line, notes in order); blocks newest first, like YouTube.
  const blocks: Comment[][] = []
  for (const c of items) {
    const last = blocks.at(-1)
    if (c.groupId && last?.[0]?.groupId === c.groupId) last.push(c)
    else blocks.push([c])
  }
  blocks.reverse()

  const all = [...drafts, ...(body.trim() ? [{ key: 'current', body, ...pinOf(pending) }] : [])]
  const postAll = () => {
    const [only] = all
    if (!only) return
    if (all.length === 1)
      add.mutate({
        params: { path: { id: video.id } },
        body: { versionN: v.n, body: only.body, ...(only.timeSec !== null ? pinOf(only) : {}) },
      })
    else
      addBatch.mutate({
        params: { path: { id: video.id } },
        body: {
          versionN: v.n,
          notes: all.map((n) => ({ body: n.body, ...(n.timeSec !== null ? pinOf(n) : {}) })),
        },
      })
  }
  const posting = add.isPending || addBatch.isPending
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

  // The moment a note is pinned to, and its spot: beside the heading, so the box stays right under it.
  const moment =
    canComment && (pending || ready) ? (
      <Group gap="xs" ml="xs" data-testid="note-moment">
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
          <Button size="xs" variant="default" leftSection={<IconMapPin size={14} />} onClick={startPin}>
            Pin to this moment
          </Button>
        ) : null}
        {pending && pending.x === null && !picking ? (
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => {
              setPicking(true)
            }}
          >
            Mark a spot
          </Button>
        ) : null}
        {pending && pending.x !== null ? (
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => {
              setPending({ ...pending, x: null, y: null })
            }}
          >
            Remove spot
          </Button>
        ) : null}
      </Group>
    ) : null

  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Group gap={8}>
          <Text fw={600}>Comments on v{v.n}</Text>
          <Text size="sm" c="var(--va-faint)" className="num">
            {items.length}
          </Text>
          {moment}
        </Group>
        <Group gap="xs">
          {canIncorporate && ready && open.length > 0 ? (
            <Tooltip
              label={
                busy ? 'Wait for the version in progress' : 'Regenerate the video with the comment feedback'
              }
            >
              <Button
                size="xs"
                variant="light"
                color="brand"
                leftSection={<IconSparkles size={14} />}
                disabled={busy}
                onClick={() => {
                  setIncorporating(true)
                }}
              >
                Incorporate feedback
              </Button>
            </Tooltip>
          ) : null}
          {canComment ? (
            <Group gap="xs" wrap="nowrap">
              {(pending || drafts.length > 0) && body.trim() ? (
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => {
                    stash()
                    composer.current?.focus()
                  }}
                >
                  Add note
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="filled"
                loading={posting}
                disabled={all.length === 0}
                onClick={postAll}
              >
                {all.length > 1 ? `Post ${all.length} notes` : 'Comment'}
              </Button>
            </Group>
          ) : null}
        </Group>
      </Group>
      {incorporating ? (
        <IncorporateModal
          video={video}
          v={v}
          open={open}
          comments={incorporating}
          onClose={() => {
            setIncorporating(false)
          }}
        />
      ) : null}
      <Stack gap="sm">
        {canComment ? (
          <form
            ref={form}
            tabIndex={-1}
            className="va-composer"
            onSubmit={(e) => {
              e.preventDefault()
              postAll()
            }}
          >
            <Stack gap="xs">
              {drafts.length ? (
                <Stack gap={4} data-testid="draft-notes">
                  {drafts.map((d) => (
                    <Group key={d.key} gap={6} wrap="nowrap" className="va-draft-note">
                      {d.timeSec !== null ? timeButton(d.timeSec, d.x !== null) : null}
                      <Text size="sm" c="var(--va-muted)" truncate style={{ flex: 1, minWidth: 0 }}>
                        {d.body}
                      </Text>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="gray"
                        aria-label="Remove this note"
                        onClick={() => {
                          setDrafts((all) => all.filter((x) => x.key !== d.key))
                        }}
                      >
                        <IconX size={12} />
                      </ActionIcon>
                    </Group>
                  ))}
                </Stack>
              ) : null}
              <Textarea
                ref={composer}
                aria-label="Add a comment"
                placeholder={
                  pending
                    ? `A note at ${clockTime(pending.timeSec)}… Enter adds it, ${mod}+Enter posts, Esc drops it`
                    : ready
                      ? 'Add a comment… Press C while watching to note a moment.'
                      : 'Add a comment…'
                }
                autosize
                minRows={3}
                maxLength={2000}
                classNames={{ input: 'va-composer-input' }}
                value={body}
                onChange={(e) => {
                  setBody(e.currentTarget.value)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    // An empty note's moment goes too.
                    if (loose.current) {
                      setPending(null)
                      setPicking(false)
                    }
                    form.current?.focus()
                    return
                  }
                  // Space in an empty note keeps watching (and lets go of its moment), as it does outside the box.
                  if (e.key === ' ' && !body && pending && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    e.preventDefault()
                    form.current?.focus()
                    void player.current?.play().catch(() => undefined)
                    return
                  }
                  if (e.key !== 'Enter' || e.shiftKey) return
                  if (e.metaKey || e.ctrlKey) {
                    e.preventDefault()
                    postAll()
                    return
                  }
                  // A note at a moment (or one of several): Enter adds it and steps out of the box, so Space plays.
                  if (pending || drafts.length) {
                    e.preventDefault()
                    if (stash()) form.current?.focus()
                  }
                }}
              />
              {ready ? (
                <Text size="xs" c="var(--va-faint)">
                  <Kbd size="xs">C</Kbd> notes the moment you're watching · <Kbd size="xs">Enter</Kbd> adds
                  the note · <Kbd size="xs">Space</Kbd> keeps watching · post them together when you're done
                </Text>
              ) : null}
            </Stack>
          </form>
        ) : null}
        {items.length === 0 ? (
          <Text size="sm" c="var(--va-faint)">
            {canComment && ready
              ? 'No comments yet. Press C while it plays to note a moment, or just write one.'
              : 'No comments yet.'}
          </Text>
        ) : null}
        {blocks.map((b) =>
          b.length === 1 && b[0] ? (
            note(b[0], true)
          ) : (
            <div key={b[0]?.groupId ?? b[0]?.id} className="va-comment-block" data-testid="comment-block">
              {b.map((c, i) => note(c, i === 0))}
            </div>
          ),
        )}
      </Stack>
    </Card>
  )
}

/** A pin's fields as the API takes them. */
function pinOf(p: { timeSec: number | null; x: number | null; y: number | null } | null) {
  return { timeSec: p?.timeSec ?? null, x: p?.x ?? null, y: p?.y ?? null }
}
