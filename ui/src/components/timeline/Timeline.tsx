// The narration timeline (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3, §5.5): four DOM lanes (Scenes,
// Narration, AI voice, Music) under a ruler, with a playhead, Cmd/Ctrl-scroll zoom and horizontal scroll. Controlled:
// the op, playhead, selection and range come in as props and changes go out as callbacks; the timeline keeps only
// its zoom and scroll. Only clips inside the render window (about a viewport either side, in tiles) are in the DOM,
// and each waveform canvas covers only its visible part, so a ten-minute narration of 200 clips stays smooth.
import { ActionIcon, Text, Tooltip } from '@mantine/core'
import { IconArrowsHorizontal, IconZoomIn, IconZoomOut } from '@tabler/icons-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import {
  clipEnd,
  clipLength,
  DUCK_RELEASE_SAMPLES,
  mergeSpans,
  outputEnd,
  placeSpans,
  resolve,
  SAMPLE_RATE,
  secondsToSamples,
  type NarrationClip,
  type Span,
} from '../../../../src/lib/timeline'
import { labelFor } from '../../lib/labels'
import { dropSample, snapTargets } from '../../lib/timeline-snap'
import {
  clampZoom,
  DEFAULT_PX_PER_SEC,
  fitZoom,
  formatTime,
  inWindow,
  sampleToX,
  visibleWindow,
  wheelZoom,
  xToSample,
  zoomBy,
} from '../../lib/timeline-view'
import { Clip } from './Clip'
import { Playhead } from './Playhead'
import { Ruler } from './Ruler'
import { Lane, Track } from './Track'
import type { ClipPart, TimelineProps } from './types'
import './timeline.css'

/** Room after the last clip or the video's end, so the end can be dragged past. */
const TAIL_SAMPLES = 2 * SAMPLE_RATE
const BUTTON_ZOOM = 1.5

const db = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10} dB`
const percent = (v: number) => `${Math.round(v * 100)}%`
const overlaps = (s: number, e: number, w: Span) => e > w[0] && s < w[1]

export function Timeline(props: TimelineProps) {
  const { op, composition, playhead, range } = props
  const live = useRef(props)
  live.current = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [pps, setPps] = useState(() => clampZoom(props.initialPxPerSec ?? DEFAULT_PX_PER_SEC))
  const ppsRef = useRef(pps)
  ppsRef.current = pps
  const fitted = useRef(props.initialPxPerSec !== undefined)
  const pendingScroll = useRef<number | null>(null)
  const [viewport, setViewport] = useState(0)
  const [win, setWin] = useState<Span>([0, 0])
  const [draft, setDraft] = useState<Span | null>(null)
  const [dropping, setDropping] = useState(false)

  const clips = useMemo(() => resolve(op.clips).map((clip, index) => ({ clip, index })), [op.clips])
  const videoEnd = secondsToSamples(composition.duration)
  const end = Math.max(videoEnd, outputEnd(op.clips))
  const width = Math.ceil(sampleToX(end + TAIL_SAMPLES, pps))

  const updateWindow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const next = visibleWindow(el.scrollLeft, el.clientWidth, ppsRef.current)
    setWin((w) => (w[0] === next[0] && w[1] === next[1] ? w : next))
  }, [])

  // The viewport's width; the first measure fits the whole composition unless a zoom was given.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => {
      setViewport(el.clientWidth)
      if (!fitted.current && el.clientWidth > 0) {
        fitted.current = true
        setPps(fitZoom(end + TAIL_SAMPLES, el.clientWidth))
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
    }
    // Fits once, on the first measure (not again when the op grows).
  }, [])

  // After a zoom the content has its new width; put the anchored scroll position back, then re-window.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pendingScroll.current !== null) el.scrollLeft = pendingScroll.current
    pendingScroll.current = null
    updateWindow()
  }, [pps, viewport, width, updateWindow])

  useEffect(() => {
    live.current.onZoomChange?.(pps)
  }, [pps])

  const zoomTo = useCallback((next: { pxPerSec: number; scrollLeft: number }) => {
    pendingScroll.current = next.scrollLeft
    ppsRef.current = next.pxPerSec
    setPps(next.pxPerSec)
  }, [])
  const currentView = () => ({
    pxPerSec: ppsRef.current,
    scrollLeft: pendingScroll.current ?? scrollRef.current?.scrollLeft ?? 0,
  })

  // Cmd/Ctrl-wheel (and trackpad pinch, which arrives as Ctrl-wheel) zooms around the pointer; a plain vertical
  // wheel scrolls the lanes sideways while they can move, then lets the page scroll. Not a React handler: those are
  // passive, and zooming must stop the browser's own page zoom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomTo(wheelZoom(currentView(), e.deltaY, e.clientX - el.getBoundingClientRect().left))
        return
      }
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      const max = el.scrollWidth - el.clientWidth
      const next = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY))
      if (next === el.scrollLeft) return
      e.preventDefault()
      el.scrollLeft = next
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
    }
  }, [zoomTo])

  const zoomButton = (factor: number) => {
    zoomTo(zoomBy(currentView(), factor, (scrollRef.current?.clientWidth ?? 0) / 2))
  }

  const sampleAt = useCallback((clientX: number) => {
    const left = contentRef.current?.getBoundingClientRect().left ?? 0
    return Math.max(0, xToSample(clientX - left, ppsRef.current))
  }, [])

  const targets = useMemo(
    () => snapTargets({ beats: composition.beats, clips: clips.map((c) => c.clip), playhead }),
    [composition.beats, clips, playhead],
  )

  // ---- narration clip events: select here, everything else goes to the editor's commands

  const onClipPointer = useCallback(
    (
      id: string,
      e: PointerEvent<HTMLDivElement>,
      phase: 'down' | 'move' | 'up' | 'cancel',
      part: ClipPart,
    ) => {
      const p = live.current
      if (phase === 'down') {
        e.stopPropagation()
        if (p.selectedClipId !== id) p.onSelectClip(id)
        if (p.onClipCommand) e.currentTarget.setPointerCapture(e.pointerId)
      } else if (!e.currentTarget.hasPointerCapture(e.pointerId) && phase !== 'up') return
      p.onClipCommand?.({
        type: 'pointer',
        phase,
        clipId: id,
        part,
        sample: sampleAt(e.clientX),
        pxPerSec: ppsRef.current,
        pointerId: e.pointerId,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      })
    },
    [sampleAt],
  )
  const onClipKey = useCallback((id: string, e: KeyboardEvent<HTMLDivElement>) => {
    const p = live.current
    if (e.key === 'Enter') {
      e.preventDefault()
      p.onSelectClip(id)
      return
    }
    const result = { handled: false }
    p.onClipCommand?.({
      type: 'key',
      clipId: id,
      key: e.key,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      handled: () => {
        result.handled = true
      },
    })
    if (result.handled) e.preventDefault()
    // Escape deselects unless the editor used it (to close its clip menu).
    else if (e.key === 'Escape') p.onSelectClip(null)
  }, [])
  const onClipMenu = useCallback((id: string, e: MouseEvent<HTMLDivElement>) => {
    const p = live.current
    e.preventDefault()
    if (p.selectedClipId !== id) p.onSelectClip(id)
    p.onClipCommand?.({ type: 'menu', clipId: id, clientX: e.clientX, clientY: e.clientY })
  }, [])

  // ---- files dropped on the Narration lane

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files')
  const drop = props.onDropFiles
    ? {
        active: dropping,
        onDragOver: (e: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        },
        onDragLeave: (e: DragEvent<HTMLDivElement>) => {
          // Leaving for a clip inside the lane isn't leaving the lane.
          if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)))
            setDropping(false)
        },
        onDrop: (e: DragEvent<HTMLDivElement>) => {
          setDropping(false)
          const files = [...e.dataTransfer.files]
          if (!files.length) return
          e.preventDefault()
          const left = contentRef.current?.getBoundingClientRect().left ?? 0
          const at = dropSample(e.clientX - left, ppsRef.current, targets, { disabled: e.altKey })
          live.current.onDropFiles?.(files, at)
        },
      }
    : undefined

  // ---- what's in the window

  const shownClips = useMemo(() => {
    const out = inWindow(clips, win, (c) => [c.clip.start, clipEnd(c.clip)])
    // The selected clip stays mounted while scrolled away, so it keeps keyboard focus.
    const sel = props.selectedClipId
    const selected =
      sel && !out.some((c) => c.clip.id === sel) ? clips.find((c) => c.clip.id === sel) : undefined
    return selected ? [...out, selected] : out
  }, [clips, win, props.selectedClipId])
  const voices = useMemo(
    () =>
      composition.beats.flatMap((b) =>
        b.voice
          ? [
              {
                beat: b,
                voice: b.voice,
                start: secondsToSamples(b.start + b.voice.start),
                length: secondsToSamples(b.voice.duration),
              },
            ]
          : [],
      ),
    [composition.beats],
  )
  const music = composition.audio.find((a) => a.role === 'music') ?? null
  const ducks = useMemo(
    () =>
      op.tracks.music.duck
        ? mergeSpans(placeSpans(op.clips, props.takeSpans ?? new Map()), DUCK_RELEASE_SAMPLES).map(
            ([s, e]): Span => [s, Math.min(e + DUCK_RELEASE_SAMPLES, end + TAIL_SAMPLES)],
          )
        : [],
    [op.clips, op.tracks.music.duck, props.takeSpans, end],
  )

  const { tracks } = op
  const narrationMuted = tracks.narration.muted
  const othersSilenced = tracks.narration.solo || tracks.original.muteAll
  const voiceMuted = tracks.aiVoice.mode === 'replace' || othersSilenced
  const musicMuted = !!music?.muted || othersSilenced
  const shownRange = draft ?? range
  const total = clips.length

  const clipLabel = (c: NarrationClip, index: number) => {
    const take = props.takeNames?.get(c.mediaId) ?? 'Take'
    const span = `${formatTime(c.start / SAMPLE_RATE, 0.1)} to ${formatTime(clipEnd(c) / SAMPLE_RATE, 0.1)}`
    const gain = c.gainDb === null ? ', silent' : ''
    return {
      label: take,
      aria: `Narration clip ${index + 1} of ${total}: ${take}, ${span}${gain}`,
    }
  }

  return (
    <div
      className="va-tl"
      role="region"
      aria-label="Timeline"
      data-testid="timeline"
      data-px-per-sec={Math.round(pps * 1000) / 1000}
    >
      <div className="va-tl-heads">
        <div className="va-tl-corner">
          <Tooltip label="Zoom out (⌘/Ctrl-scroll)">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Zoom out"
              onClick={() => zoomButton(1 / BUTTON_ZOOM)}
            >
              <IconZoomOut size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Zoom in (⌘/Ctrl-scroll)">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Zoom in"
              onClick={() => zoomButton(BUTTON_ZOOM)}
            >
              <IconZoomIn size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Fit the whole video">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Zoom to fit"
              onClick={() => {
                zoomTo({ pxPerSec: fitZoom(end + TAIL_SAMPLES, viewport), scrollLeft: 0 })
              }}
            >
              <IconArrowsHorizontal size={14} />
            </ActionIcon>
          </Tooltip>
        </div>
        <Track lane="scenes" name="Scenes" note="Read-only" />
        <Track
          lane="narration"
          name="Narration"
          muted={narrationMuted}
          onMute={(muted) => props.onTrackChange({ lane: 'narration', set: { muted } })}
          solo={tracks.narration.solo}
          onSolo={(solo) => props.onTrackChange({ lane: 'narration', set: { solo } })}
          volume={{
            value: tracks.narration.volumeDb,
            min: -30,
            max: 12,
            step: 0.5,
            format: db,
            onChange: (volumeDb) => props.onTrackChange({ lane: 'narration', set: { volumeDb } }),
          }}
        />
        <Track
          lane="aiVoice"
          name="AI voice"
          {...(voices.length ? {} : { note: 'No AI voice' })}
          muted={tracks.aiVoice.mode === 'replace'}
          onMute={(muted) =>
            props.onTrackChange({
              lane: 'aiVoice',
              set: { mode: muted ? 'replace' : tracks.aiVoice.volumeDb < 0 ? 'under' : 'keep' },
            })
          }
          volume={{
            value: tracks.aiVoice.mode === 'keep' ? 0 : tracks.aiVoice.volumeDb,
            min: -30,
            max: 0,
            step: 0.5,
            format: db,
            disabled: !voices.length,
            onChange: (volumeDb) =>
              props.onTrackChange({
                lane: 'aiVoice',
                set: {
                  volumeDb,
                  ...(tracks.aiVoice.mode === 'replace' ? {} : { mode: volumeDb < 0 ? 'under' : 'keep' }),
                },
              }),
          }}
        />
        {music ? (
          <Track
            lane="music"
            name="Music"
            muted={music.muted}
            onMute={(muted) => props.onTrackChange({ lane: 'musicLevel', audioId: music.id, set: { muted } })}
            volume={{
              value: music.volume,
              min: 0,
              max: 1,
              step: 0.01,
              format: percent,
              onChange: (volume) =>
                props.onTrackChange({ lane: 'musicLevel', audioId: music.id, set: { volume } }),
            }}
            duck={{
              on: tracks.music.duck,
              onToggle: (duck) => props.onTrackChange({ lane: 'music', set: { duck } }),
              amount: {
                value: tracks.music.duckDb,
                min: -30,
                max: 0,
                step: 1,
                format: db,
                onChange: (duckDb) => props.onTrackChange({ lane: 'music', set: { duckDb } }),
              },
            }}
          />
        ) : (
          <Track lane="music" name="Music" note="No music" />
        )}
      </div>

      <div className="va-tl-scroll" ref={scrollRef} onScroll={updateWindow} data-testid="timeline-scroll">
        <div className="va-tl-content" ref={contentRef} style={{ width }}>
          <Ruler
            pxPerSec={pps}
            window={win}
            end={end}
            playhead={playhead}
            targets={targets}
            sampleAt={sampleAt}
            onSeek={props.onSeek}
            onRangeSelect={props.onRangeSelect}
            onDraft={setDraft}
            hasRange={range !== null}
          />

          <Lane lane="scenes" name="Scenes">
            {composition.beats.map((b) => {
              const s = secondsToSamples(b.start)
              const e = secondsToSamples(b.start + b.duration)
              if (!overlaps(s, e, win)) return null
              const name = labelFor(b.label, b.id)
              return (
                <div
                  key={b.id}
                  className="va-tl-scene"
                  title={name}
                  style={{ left: sampleToX(s, pps), width: sampleToX(e - s, pps) }}
                >
                  <span className="va-tl-clip-label">{name}</span>
                </div>
              )
            })}
          </Lane>

          <Lane
            lane="narration"
            name="Narration"
            muted={narrationMuted}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget && props.selectedClipId) props.onSelectClip(null)
            }}
            {...(drop ? { drop } : {})}
          >
            {drop && !clips.length ? (
              <Text size="xs" c="var(--va-faint)" className="va-tl-drop-hint">
                Drop an audio file here
              </Text>
            ) : null}
            {shownClips.map(({ clip: c, index }) => {
              const l = clipLabel(c, index)
              return (
                <Clip
                  key={c.id}
                  id={c.id}
                  start={c.start}
                  length={clipLength(c)}
                  srcStart={c.srcStart}
                  label={l.label}
                  ariaLabel={l.aria}
                  tone="narration"
                  pxPerSec={pps}
                  window={win}
                  peaks={props.peaks.get(c.mediaId)}
                  selected={props.selectedClipId === c.id}
                  muted={narrationMuted || c.gainDb === null}
                  interactive
                  onPointer={onClipPointer}
                  onKey={onClipKey}
                  {...(props.onClipCommand ? { onMenu: onClipMenu } : {})}
                />
              )
            })}
          </Lane>

          <Lane lane="aiVoice" name="AI voice" muted={voiceMuted}>
            {voices.map((v) =>
              overlaps(v.start, v.start + v.length, win) ? (
                <Clip
                  key={v.voice.id}
                  id={v.voice.id}
                  start={v.start}
                  length={v.length}
                  srcStart={0}
                  label={labelFor(v.beat.label, v.beat.id)}
                  ariaLabel={`AI voice for ${labelFor(v.beat.label, v.beat.id)}`}
                  tone="voice"
                  pxPerSec={pps}
                  window={win}
                  peaks={props.voicePeaks?.get(v.voice.id)}
                  muted={voiceMuted}
                />
              ) : null,
            )}
          </Lane>

          <Lane lane="music" name="Music" muted={musicMuted}>
            {music && videoEnd > 0 ? (
              <Clip
                id={music.id}
                start={0}
                length={videoEnd}
                srcStart={0}
                label={music.label ?? 'Music'}
                ariaLabel={music.label ?? 'Music'}
                tone="music"
                pxPerSec={pps}
                window={win}
                muted={musicMuted}
              />
            ) : null}
            {ducks.map(([s, e]) =>
              overlaps(s, e, win) ? (
                <div
                  key={s}
                  className="va-tl-duck"
                  aria-hidden
                  style={{ left: sampleToX(s, pps), width: sampleToX(e - s, pps) }}
                />
              ) : null,
            )}
          </Lane>

          {end > videoEnd ? (
            <div
              className="va-tl-past"
              aria-hidden
              title="Past the end of the video"
              style={{ left: sampleToX(videoEnd, pps) }}
            />
          ) : null}
          {shownRange ? (
            <div
              className="va-tl-range"
              data-testid="timeline-range"
              aria-hidden
              style={{
                left: sampleToX(shownRange[0], pps),
                width: sampleToX(shownRange[1] - shownRange[0], pps),
              }}
            />
          ) : null}
          <Playhead sample={playhead} pxPerSec={pps} />
        </div>
      </div>
      <Text size="xs" className="va-tl-sr" aria-live="polite">
        {range
          ? `Selected ${formatTime(range[0] / SAMPLE_RATE, 0.1)} to ${formatTime(range[1] / SAMPLE_RATE, 0.1)}`
          : ''}
      </Text>
    </div>
  )
}
