// The time ruler: ticks that adapt to the zoom, drawn only inside the render window. A click seeks; a drag selects a
// range (the punch-in range), snapping its ends to beats, clip edges and the playhead unless Alt / Option is held.
// It's also the keyboard seek control: a slider over the composition (arrows move a frame, Shift ten, Home / End).
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { frameStart, frameAt, SAMPLE_RATE, type Span } from '../../../../src/lib/timeline'
import { snap, type SnapTarget } from '../../lib/timeline-snap'
import { formatTime, sampleToX, spokenTime, tickStep, ticks } from '../../lib/timeline-view'

const FPS = 30
/** A pointer that moves this far (CSS px) is dragging a range, not clicking. */
const DRAG_PX = 4

export interface RulerProps {
  pxPerSec: number
  window: Span
  /** End of the seekable range, samples. */
  end: number
  playhead: number
  targets: readonly SnapTarget[]
  /** Composition sample at a viewport x (clientX). */
  sampleAt: (clientX: number) => number
  onSeek: (sample: number) => void
  onRangeSelect: (range: Span | null) => void
  /** The range while it's being dragged (null when the drag ends). */
  onDraft: (range: Span | null) => void
  hasRange: boolean
}

export function Ruler(p: RulerProps) {
  const drag = useRef<{ x: number; anchor: number; moved: boolean; range: Span | null } | null>(null)
  const { step } = tickStep(p.pxPerSec)
  const clamp = (s: number) => Math.max(0, Math.min(p.end, s))

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const raw = clamp(p.sampleAt(e.clientX))
    drag.current = {
      x: e.clientX,
      anchor: snap(raw, p.targets, p.pxPerSec, { disabled: e.altKey }).sample,
      moved: false,
      range: null,
    }
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_PX) return
    d.moved = true
    const at = snap(clamp(p.sampleAt(e.clientX)), p.targets, p.pxPerSec, { disabled: e.altKey }).sample
    d.range = at < d.anchor ? [at, d.anchor] : [d.anchor, at]
    p.onDraft(d.range)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) {
      p.onDraft(null)
      p.onRangeSelect(d.range && d.range[1] > d.range[0] ? d.range : null)
      return
    }
    if (p.hasRange) p.onRangeSelect(null)
    p.onSeek(clamp(p.sampleAt(e.clientX)))
  }
  const cancel = () => {
    drag.current = null
    p.onDraft(null)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const frame = frameAt(p.playhead, FPS)
    const by = e.shiftKey ? 10 : 1
    const next =
      e.key === 'ArrowLeft'
        ? frameStart(Math.max(0, frame - by), FPS)
        : e.key === 'ArrowRight'
          ? frameStart(frame + by, FPS)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? p.end
              : e.key === 'Escape' && p.hasRange
                ? null
                : undefined
    if (next === undefined) return
    e.preventDefault()
    if (next === null) p.onRangeSelect(null)
    else p.onSeek(clamp(next))
  }

  const [from, to] = p.window
  const seconds = p.playhead / SAMPLE_RATE
  return (
    <div
      className="va-tl-ruler"
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={Math.round((p.end / SAMPLE_RATE) * 10) / 10}
      aria-valuenow={Math.round(seconds * 10) / 10}
      aria-valuetext={spokenTime(seconds)}
      data-testid="timeline-ruler"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onKeyDown={key}
    >
      {ticks(from / SAMPLE_RATE, Math.min(to, p.end) / SAMPLE_RATE, p.pxPerSec).map((t) => (
        <span
          key={t.t}
          className="va-tl-tick"
          data-major={t.major ? '' : undefined}
          style={{ left: sampleToX(t.t * SAMPLE_RATE, p.pxPerSec) }}
        >
          {t.major ? <span className="va-tl-tick-label num">{formatTime(t.t, step)}</span> : null}
        </span>
      ))}
    </div>
  )
}
