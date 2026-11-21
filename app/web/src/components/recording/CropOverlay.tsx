// The crop rectangle on the demo setup's picture (docs/guides/screen-recordings.md "Crop"). While cropping, drag its
// corners and edges to resize it, the inside to move it, or anywhere outside (anywhere at all, while it's still the
// whole picture) to draw a new one; arrow keys nudge a
// focused handle. Otherwise it only shows what's kept: everything outside is dimmed.
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import {
  CROP_HANDLES,
  dragCrop,
  drawCrop,
  isWhole,
  type CropBox,
  type CropHandle,
} from '../../lib/demo-setup'

const NAMES: Record<Exclude<CropHandle, 'move'>, string> = {
  nw: 'top left corner',
  n: 'top edge',
  ne: 'top right corner',
  e: 'right edge',
  se: 'bottom right corner',
  s: 'bottom edge',
  sw: 'bottom left corner',
  w: 'left edge',
}
const CURSORS: Record<Exclude<CropHandle, 'move'>, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}
/** A handle's touch target, in px (the mark drawn inside it is smaller). */
const HIT = 28

export function CropOverlay(props: {
  value: CropBox
  /** Cropping: the rectangle can be changed. Off: it's only shown. */
  active: boolean
  /** The least it may keep, each way, as fractions. */
  min: [number, number]
  onChange: (c: CropBox) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{ handle: CropHandle | 'draw'; x0: number; y0: number; box: CropBox } | null>(null)
  const [x, y, w, h] = props.value
  const at = (e: ReactPointerEvent) => {
    const r = root.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }
  const start = (e: ReactPointerEvent, handle: CropHandle | 'draw') => {
    e.stopPropagation()
    const p = at(e)
    drag.current = { handle, x0: p.x, y0: p.y, box: props.value }
    root.current?.setPointerCapture(e.pointerId)
  }
  if (!props.active && isWhole(props.value)) return null
  return (
    <div
      ref={root}
      data-testid="crop-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        touchAction: 'none',
        pointerEvents: props.active ? 'auto' : 'none',
        cursor: 'crosshair',
      }}
      onPointerDown={(e) => {
        start(e, 'draw')
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const p = at(e)
        if (d.handle === 'draw') {
          // A press without a drag keeps the crop as it was.
          if (Math.abs(p.x - d.x0) < 0.01 && Math.abs(p.y - d.y0) < 0.01) return
          props.onChange(drawCrop(d.x0, d.y0, p.x, p.y, props.min))
        } else props.onChange(dragCrop(d.box, d.handle, p.x - d.x0, p.y - d.y0, props.min))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
    >
      <div
        data-testid="crop-box"
        onPointerDown={(e) => {
          // The whole picture can't move anywhere: a drag on it draws the crop instead.
          start(e, isWhole(props.value) ? 'draw' : 'move')
        }}
        style={{
          position: 'absolute',
          left: `${String(x * 100)}%`,
          top: `${String(y * 100)}%`,
          width: `${String(w * 100)}%`,
          height: `${String(h * 100)}%`,
          // Everything outside the crop is dimmed (the picture clips the shadow).
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
          outline: props.active ? '2px solid #fff' : '1px dashed rgba(255, 255, 255, 0.8)',
          cursor: props.active ? 'move' : 'default',
        }}
      >
        {props.active
          ? CROP_HANDLES.map((k) => (
              <div
                key={k}
                role="button"
                tabIndex={0}
                aria-label={`Crop ${NAMES[k]}`}
                data-testid={`crop-handle-${k}`}
                onPointerDown={(e) => {
                  start(e, k)
                }}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 0.05 : 0.01
                  const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
                  const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
                  if (!dx && !dy) return
                  e.preventDefault()
                  props.onChange(dragCrop(props.value, k, dx, dy, props.min))
                }}
                style={{
                  position: 'absolute',
                  width: HIT,
                  height: HIT,
                  left: k.includes('w') ? 0 : k.includes('e') ? '100%' : '50%',
                  top: k.includes('n') ? 0 : k.includes('s') ? '100%' : '50%',
                  // Inside the rectangle, so a handle at the picture's edge is whole and can be grabbed.
                  transform: `translate(${k.includes('w') ? '0' : k.includes('e') ? '-100%' : '-50%'}, ${k.includes('n') ? '0' : k.includes('s') ? '-100%' : '-50%'})`,
                  display: 'grid',
                  justifyItems: k.includes('w') ? 'start' : k.includes('e') ? 'end' : 'center',
                  alignItems: k.includes('n') ? 'start' : k.includes('s') ? 'end' : 'center',
                  padding: 2,
                  cursor: CURSORS[k],
                  touchAction: 'none',
                }}
              >
                <div
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 2,
                    background: '#fff',
                    boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.5)',
                  }}
                />
              </div>
            ))
          : null}
      </div>
    </div>
  )
}
