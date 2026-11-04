// The playhead: a line over the ruler and every lane at the current composition sample. The line itself takes no
// pointer events (clips under it stay clickable); a narrow grip around it can be dragged to scrub, like a video
// editor's playhead. A click elsewhere in the ruler or lanes seeks too (Ruler, Timeline).
import { useRef, type PointerEvent } from 'react'
import { sampleToX } from '../../lib/timeline-view'

export function Playhead(p: {
  sample: number
  pxPerSec: number
  /** Called with the pointer's clientX while the grip is dragged. */
  onScrub?: (clientX: number) => void
}) {
  const dragging = useRef(false)
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !p.onScrub) return
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) p.onScrub?.(e.clientX)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    p.onScrub?.(e.clientX)
  }
  return (
    <div
      className="va-tl-playhead"
      aria-hidden
      data-testid="timeline-playhead"
      data-sample={p.sample}
      style={{ transform: `translateX(${sampleToX(p.sample, p.pxPerSec)}px)` }}
    >
      {p.onScrub ? (
        <div
          className="va-tl-playhead-grip"
          data-testid="timeline-playhead-grip"
          aria-hidden
          title="Drag to scrub"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => {
            dragging.current = false
          }}
        />
      ) : null}
    </div>
  )
}
