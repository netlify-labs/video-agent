// One clip on a lane: a block placed by its start and length in composition samples, with its waveform drawn on a
// canvas from the take's peaks pyramid. The canvas covers only the part of the clip inside the render window, so a
// ten-minute clip at frame zoom never needs a canvas wider than a few viewports. Narration clips are focusable and
// carry trim handles; their pointer, key and context-menu events go to the editor's commands through the timeline.
import { memo, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import type { Peaks } from '../../../../src/lib/peaks'
import type { Span } from '../../../../src/lib/timeline'
import { sampleToX, waveformColumns } from '../../lib/timeline-view'
import type { ClipPart } from './types'

/** Browsers refuse canvases much wider than this. */
const MAX_CANVAS_PX = 16_384
/** Narrower clips show no label (the waveform reads better than "T…"). */
const LABEL_MIN_PX = 40

export type ClipTone = 'narration' | 'voice' | 'music'

export interface ClipProps {
  id: string
  /** Composition samples. */
  start: number
  length: number
  /** Source sample of the take at `start` (where the waveform begins). */
  srcStart: number
  label: string
  ariaLabel: string
  /** A short tag after the label (a clip's take count). */
  badge?: string | undefined
  tone: ClipTone
  pxPerSec: number
  /** The render window, composition samples. */
  window: Span
  peaks?: Peaks | undefined
  selected?: boolean
  /** Focusable, selectable and trimmable (narration); read-only clips are just shown. */
  interactive?: boolean
  muted?: boolean
  /** Stable across renders (they take the clip id), so unchanged clips don't re-render. */
  onPointer?: (
    id: string,
    e: PointerEvent<HTMLDivElement>,
    phase: 'down' | 'move' | 'up' | 'cancel',
    part: ClipPart,
  ) => void
  onKey?: (id: string, e: KeyboardEvent<HTMLDivElement>) => void
  onMenu?: (id: string, e: MouseEvent<HTMLDivElement>) => void
}

const partOf = (target: EventTarget): ClipPart => {
  const p = (target as HTMLElement).dataset.part
  return p === 'start' || p === 'end' ? p : 'body'
}

export const Clip = memo(function Clip(p: ClipProps) {
  const left = sampleToX(p.start, p.pxPerSec)
  const width = Math.max(1, sampleToX(p.length, p.pxPerSec))
  // The visible part, in samples from the clip's start.
  const from = Math.max(0, p.window[0] - p.start)
  const to = Math.min(p.length, p.window[1] - p.start)
  const handlers = p.interactive
    ? {
        tabIndex: 0,
        role: 'button',
        'aria-pressed': !!p.selected,
        onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
          if (e.button === 0) p.onPointer?.(p.id, e, 'down', partOf(e.target))
        },
        onPointerMove: (e: PointerEvent<HTMLDivElement>) => p.onPointer?.(p.id, e, 'move', partOf(e.target)),
        onPointerUp: (e: PointerEvent<HTMLDivElement>) => p.onPointer?.(p.id, e, 'up', partOf(e.target)),
        onPointerCancel: (e: PointerEvent<HTMLDivElement>) =>
          p.onPointer?.(p.id, e, 'cancel', partOf(e.target)),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => p.onKey?.(p.id, e),
        ...(p.onMenu
          ? {
              'aria-haspopup': 'menu' as const,
              'aria-keyshortcuts': 'S Delete ArrowLeft ArrowRight Shift+F10',
              onContextMenu: (e: MouseEvent<HTMLDivElement>) => p.onMenu?.(p.id, e),
            }
          : {}),
      }
    : { 'aria-hidden': true }
  return (
    <div
      className="va-tl-clip"
      data-tone={p.tone}
      data-selected={p.selected ? '' : undefined}
      data-muted={p.muted ? '' : undefined}
      data-clip-id={p.id}
      aria-label={p.interactive ? p.ariaLabel : undefined}
      title={p.interactive ? undefined : p.ariaLabel}
      style={{ left, width }}
      {...handlers}
    >
      {p.peaks && to > from ? (
        <Waveform
          peaks={p.peaks}
          srcFrom={p.srcStart + from}
          srcTo={p.srcStart + to}
          left={sampleToX(from, p.pxPerSec)}
          width={sampleToX(to - from, p.pxPerSec)}
          pxPerSec={p.pxPerSec}
        />
      ) : null}
      {width >= LABEL_MIN_PX ? (
        <span className="va-tl-clip-label">
          {p.badge ? (
            <span className="va-tl-clip-badge" data-testid="clip-takes-badge">
              {p.badge}
            </span>
          ) : null}
          {p.label}
        </span>
      ) : null}
      {p.interactive ? (
        <>
          <span className="va-tl-handle" data-part="start" aria-hidden />
          <span className="va-tl-handle" data-part="end" aria-hidden />
        </>
      ) : null}
    </div>
  )
})

/** Draws source samples [srcFrom, srcTo) as min/max columns, mirrored around the middle, in the canvas's color. */
function Waveform(p: {
  peaks: Peaks
  srcFrom: number
  srcTo: number
  left: number
  width: number
  pxPerSec: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    const cols = Math.min(MAX_CANVAS_PX, Math.max(1, Math.round(p.width * dpr)))
    const rows = Math.max(1, Math.round(canvas.clientHeight * dpr))
    canvas.width = cols
    canvas.height = rows
    // Columns are per device pixel when the canvas fits; past the cap each stretches over a few.
    const colsData = waveformColumns(
      p.peaks,
      p.srcFrom,
      p.srcTo,
      cols,
      p.pxPerSec,
      cols / Math.max(1, p.width),
    )
    ctx.clearRect(0, 0, cols, rows)
    ctx.fillStyle = getComputedStyle(canvas).color
    const mid = rows / 2
    for (let x = 0; x < cols; x++) {
      const lo = colsData[2 * x] ?? 0
      const hi = colsData[2 * x + 1] ?? 0
      if (lo === 0 && hi === 0) continue
      const top = mid - (hi / 127) * mid
      const bottom = mid - (lo / 127) * mid
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
    }
  }, [p.peaks, p.srcFrom, p.srcTo, p.width, p.pxPerSec])
  return (
    <canvas
      ref={ref}
      className="va-tl-wave"
      aria-hidden
      data-src-from={p.srcFrom}
      style={{ left: p.left, width: p.width }}
    />
  )
}
