// The sandboxed composition preview (plan v2 §7; design from spike S2). Plays a version's composition in
// <iframe sandbox="allow-scripts"> with its own channel, accepts only schema-valid messages from that iframe's
// window (ready, time, click, error, edits-applied) and sends only play, pause, seek and apply-edits. The link is
// renewed before it expires, and a saved draft reloaded, without losing the playhead or flashing: the new frame loads
// hidden behind the shown one and replaces it once it's at the same moment.
import { ActionIcon, Group, Slider, Stack, Text } from '@mantine/core'
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
// zod/mini: the same validation as classic zod at a fraction of the bundle size.
import * as z from 'zod/mini'
import { fetchClient } from '../api/client'
import { clockTime } from './bits'

const Msg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), channel: z.string(), duration: z.number().check(z.nonnegative()) }),
  z.object({ type: z.literal('time'), channel: z.string(), time: z.number().check(z.nonnegative()) }),
  z.object({
    type: z.literal('click'),
    channel: z.string(),
    x: z.number().check(z.minimum(0), z.maximum(1)),
    y: z.number().check(z.minimum(0), z.maximum(1)),
    textId: z.nullable(z.string().check(z.maxLength(200))),
  }),
  z.object({ type: z.literal('error'), channel: z.string(), message: z.string().check(z.maxLength(300)) }),
  z.object({ type: z.literal('edits-applied'), channel: z.string(), count: z.int() }),
])
export type PreviewMessage = z.infer<typeof Msg>

export type PreviewCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'apply-edits'; edits: { id: string; text: string }[] }

interface Link {
  url: string
  expiresAt: string
  channel: string
}

/** Renew this long before the link expires. */
const RENEW_EARLY_MS = 60_000

export function CompositionPreview({
  videoId,
  versionN,
  dimensions,
  live = false,
  draft,
  onClick,
  onMessage,
  onReady,
}: {
  videoId: string
  versionN: number
  /** An edit draft instead of the version; the preview reloads when `key` changes (a save it can't show live). */
  draft?: { editId: string; key: string }
  /** Called with a sender once the frame is ready, e.g. to apply text edits instantly. */
  onReady?: (send: (c: PreviewCommand) => void) => void
  /** A running version's latest checkpoint snapshot instead of the finished bundle. */
  live?: boolean
  /** The composition's own size: it renders at that size, scaled to fit. */
  dimensions: { width: number; height: number }
  onClick?: (c: { textId: string | null; x: number; y: number }) => void
  onMessage?: (m: PreviewMessage) => void
}) {
  const timeRef = useRef(0)
  const playingRef = useRef(false)
  // Not a cached query: app-wide invalidations (after a comment, a publish…) must not mint a new link and reload
  // the frame. Fetched on mount and again before it expires. A reload goes to `next`, shown once it's ready.
  const [link, setLink] = useState<Link | null>(null)
  const [next, setNext] = useState<Link | null>(null)
  const shown = useRef(false)
  const [failed, setFailed] = useState(false)
  const editId = draft?.editId
  const load = useCallback(async () => {
    const { data } = editId
      ? await fetchClient.GET('/api/v1/edits/{id}/preview', { params: { path: { id: editId } } })
      : await fetchClient.GET('/api/v1/videos/{id}/versions/{n}/preview', {
          params: live
            ? { path: { id: videoId, n: versionN }, query: { live: '1' } }
            : { path: { id: videoId, n: versionN } },
        })
    if (data) {
      // A fresh channel per load: messages from an older load (or anyone else) never match.
      const l = { ...data, channel: crypto.randomUUID() }
      if (shown.current) setNext(l)
      else {
        shown.current = true
        setLink(l)
      }
    } else if (!shown.current) setFailed(true)
  }, [videoId, versionN, live, editId])
  useEffect(() => {
    void load()
  }, [load])
  // A save the preview can't show live: reload it at the same moment.
  const key = draft?.key
  const firstKey = useRef(key)
  useEffect(() => {
    if (key === undefined || key === firstKey.current) return
    firstKey.current = key
    void load()
  }, [key, load])
  const frame = useRef<HTMLIFrameElement>(null)
  const nextFrame = useRef<HTMLIFrameElement>(null)
  const channel = link?.channel
  const nextChannel = next?.channel
  // Where the hidden frame was sent, once it's ready; it's shown when it reports being there.
  const nextAt = useRef<number | null>(null)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      setScale(el.clientWidth / dimensions.width)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
  }, [dimensions.width])

  const send = (c: PreviewCommand) => {
    frame.current?.contentWindow?.postMessage({ ...c, channel }, '*')
  }
  const sendNext = (c: PreviewCommand) => {
    nextFrame.current?.contentWindow?.postMessage({ ...c, channel: nextChannel }, '*')
  }
  const promote = (duration: number) => {
    if (!next) return
    nextAt.current = null
    setLink(next)
    setNext(null)
    setDuration(duration)
    setError(null)
  }
  const nextDuration = useRef(0)

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // The hidden frame: bring it to the shown frame's moment (and playing state), then swap.
      if (nextFrame.current && e.source === nextFrame.current.contentWindow) {
        const parsed = Msg.safeParse(e.data)
        if (!parsed.success || parsed.data.channel !== nextChannel) return
        const m = parsed.data
        if (m.type === 'ready') {
          nextDuration.current = m.duration
          const at = Math.min(timeRef.current, m.duration)
          if (at < 0.02) {
            if (playingRef.current) sendNext({ type: 'play' })
            promote(m.duration)
          } else {
            nextAt.current = at
            sendNext({ type: 'seek', time: at })
            if (playingRef.current) sendNext({ type: 'play' })
          }
        } else if (m.type === 'time' && nextAt.current !== null) promote(nextDuration.current)
        else if (m.type === 'error') promote(nextDuration.current)
        return
      }
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const parsed = Msg.safeParse(e.data)
      if (!parsed.success || parsed.data.channel !== channel) return
      const m = parsed.data
      if (m.type === 'ready') {
        setReady(true)
        setDuration(m.duration)
        setError(null)
        onReady?.(send)
      } else if (m.type === 'time') {
        timeRef.current = m.time
        setTime(m.time)
      } else if (m.type === 'click') onClick?.({ textId: m.textId, x: m.x, y: m.y })
      else if (m.type === 'error') setError(m.message)
      onMessage?.(m)
    }
    window.addEventListener('message', onMsg)
    return () => {
      window.removeEventListener('message', onMsg)
    }
  }, [channel, nextChannel, next, onClick, onMessage, onReady])

  // A promoted frame was already ready: it won't say so again, so hand its sender over now (once per shown frame).
  useEffect(() => {
    if (link && shown.current && ready) onReady?.(send)
  }, [link?.url])

  // Renew before the link expires, coming back to the same moment.
  useEffect(() => {
    if (!link) return
    const ms = new Date(link.expiresAt).getTime() - Date.now() - RENEW_EARLY_MS
    const t = setTimeout(
      () => {
        void load()
      },
      Math.max(5_000, ms),
    )
    return () => {
      clearTimeout(t)
    }
  }, [link, load])

  return (
    <Stack gap={6}>
      <div
        ref={box}
        className="va-preview-frame"
        style={{ aspectRatio: `${dimensions.width} / ${dimensions.height}` }}
      >
        {live ? (
          // A running version's snapshot is the agent's draft, not the video: say so on the picture itself.
          <span className="va-live-badge" data-testid="live-draft-badge">
            <i aria-hidden />
            Live draft
          </span>
        ) : null}
        {link ? (
          // Same parent, same order: the shown frame first, the loading one after. Promoting drops the first, so the
          // loaded frame never moves in the DOM (moving an iframe reloads it). It sits underneath until then.
          [link, next].map((l) =>
            l ? (
              <iframe
                ref={l === link ? frame : nextFrame}
                key={l.url}
                title={l === link ? 'Composition preview' : 'Composition preview (loading)'}
                sandbox="allow-scripts"
                // Sound plays when the person presses play here: the click is in this page, not the frame's.
                allow="autoplay"
                src={`${l.url}#ch=${l.channel}`}
                data-testid={l === link ? 'composition-preview' : 'composition-preview-next'}
                {...(l === link ? {} : { 'aria-hidden': true, tabIndex: -1 })}
                style={{
                  width: dimensions.width,
                  height: dimensions.height,
                  transform: `scale(${scale})`,
                  transformOrigin: '0 0',
                  zIndex: l === link ? 1 : 0,
                  pointerEvents: l === link ? undefined : 'none',
                }}
              />
            ) : null,
          )
        ) : (
          <Text size="sm" c="var(--va-faint)" p="md">
            {failed ? "This version can't be previewed." : 'Loading the preview…'}
          </Text>
        )}
      </div>
      <Group gap="xs" wrap="nowrap">
        <ActionIcon
          variant="default"
          aria-label={playing ? 'Pause preview' : 'Play preview'}
          disabled={!ready}
          onClick={() => {
            send({ type: playing ? 'pause' : 'play' })
            playingRef.current = !playing
            setPlaying(!playing)
          }}
        >
          {playing ? <IconPlayerPauseFilled size={14} /> : <IconPlayerPlayFilled size={14} />}
        </ActionIcon>
        <Slider
          style={{ flex: 1 }}
          aria-label="Preview position"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.05}
          value={Math.min(time, duration)}
          disabled={!ready}
          label={(v) => clockTime(v)}
          onChange={(v) => {
            setTime(v)
            send({ type: 'seek', time: v })
          }}
        />
        <Text size="xs" c="var(--va-faint)" className="num" w={78} ta="right">
          {clockTime(time)} / {clockTime(duration)}
        </Text>
      </Group>
      <Text size="xs" c="var(--va-faint)">
        {error
          ? `Preview problem: ${error}`
          : live
            ? 'Live draft: what the agent has written so far, played in your browser. The real video appears here when the render finishes.'
            : 'A live preview of the composition: close to, not exactly, the final video.'}
      </Text>
    </Stack>
  )
}
