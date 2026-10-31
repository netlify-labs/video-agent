// The sandboxed composition preview (plan v2 §7; design from spike S2). Plays a version's composition in
// <iframe sandbox="allow-scripts"> with its own channel, accepts only schema-valid messages from that iframe's
// window (ready, time, click, error, edits-applied) and sends only play, pause, seek and apply-edits. The link is
// renewed before it expires without losing the playhead.
import { ActionIcon, Group, Slider, Stack, Text } from '@mantine/core'
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { fetchClient } from '../api/client'

const Msg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), channel: z.string(), duration: z.number().nonnegative() }),
  z.object({ type: z.literal('time'), channel: z.string(), time: z.number().nonnegative() }),
  z.object({
    type: z.literal('click'),
    channel: z.string(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    textId: z.string().max(200).nullable(),
  }),
  z.object({ type: z.literal('error'), channel: z.string(), message: z.string().max(300) }),
  z.object({ type: z.literal('edits-applied'), channel: z.string(), count: z.number().int() }),
])
export type PreviewMessage = z.infer<typeof Msg>

export type PreviewCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'apply-edits'; edits: { id: string; text: string }[] }

/** Renew this long before the link expires. */
const RENEW_EARLY_MS = 60_000

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function CompositionPreview({
  videoId,
  versionN,
  dimensions,
  live = false,
  onClick,
  onMessage,
}: {
  videoId: string
  versionN: number
  /** A running version's latest checkpoint snapshot instead of the finished bundle. */
  live?: boolean
  /** The composition's own size: it renders at that size, scaled to fit. */
  dimensions: { width: number; height: number }
  onClick?: (c: { textId: string | null; x: number; y: number }) => void
  onMessage?: (m: PreviewMessage) => void
}) {
  // Not a cached query: app-wide invalidations (after a comment, a publish…) must not mint a new link and reload
  // the frame. Fetched on mount and again before it expires.
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const load = useCallback(async () => {
    const { data } = await fetchClient.GET('/api/v1/videos/{id}/versions/{n}/preview', {
      params: live
        ? { path: { id: videoId, n: versionN }, query: { live: '1' } }
        : { path: { id: videoId, n: versionN } },
    })
    if (data) setLink(data)
    else setFailed(true)
  }, [videoId, versionN, live])
  useEffect(() => {
    void load()
  }, [load])
  const frame = useRef<HTMLIFrameElement>(null)
  // A fresh channel per load: messages from an older load (or anyone else) never match.
  const channel = useMemo(() => crypto.randomUUID(), [link?.url])
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const resumeAt = useRef<number | null>(null)
  const timeRef = useRef(0)
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

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const parsed = Msg.safeParse(e.data)
      if (!parsed.success || parsed.data.channel !== channel) return
      const m = parsed.data
      if (m.type === 'ready') {
        setReady(true)
        setDuration(m.duration)
        setError(null)
        if (resumeAt.current !== null) {
          send({ type: 'seek', time: resumeAt.current })
          resumeAt.current = null
        }
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
  }, [channel, onClick, onMessage])

  // Renew before the link expires, coming back to the same moment.
  useEffect(() => {
    if (!link) return
    const ms = new Date(link.expiresAt).getTime() - Date.now() - RENEW_EARLY_MS
    const t = setTimeout(
      () => {
        resumeAt.current = timeRef.current
        setReady(false)
        setPlaying(false)
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
        {link ? (
          <iframe
            ref={frame}
            key={link.url}
            title="Composition preview"
            sandbox="allow-scripts"
            src={`${link.url}#ch=${channel}`}
            data-testid="composition-preview"
            style={{
              width: dimensions.width,
              height: dimensions.height,
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
            }}
          />
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
          label={(v) => clock(v)}
          onChange={(v) => {
            setTime(v)
            send({ type: 'seek', time: v })
          }}
        />
        <Text size="xs" c="var(--va-faint)" className="num" w={78} ta="right">
          {clock(time)} / {clock(duration)}
        </Text>
      </Group>
      <Text size="xs" c="var(--va-faint)">
        {error
          ? `Preview problem: ${error}`
          : live
            ? 'The composition as the agent last saved it: a work in progress, not the final video.'
            : 'A live preview of the composition: close to, not exactly, the final video.'}
      </Text>
    </Stack>
  )
}
