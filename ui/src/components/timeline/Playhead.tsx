// The playhead: a line over the ruler and every lane at the current composition sample. It doesn't take pointer
// events; seeking is the ruler's job.
import { sampleToX } from '../../lib/timeline-view'

export function Playhead(p: { sample: number; pxPerSec: number }) {
  return (
    <div
      className="va-tl-playhead"
      aria-hidden
      data-testid="timeline-playhead"
      data-sample={p.sample}
      style={{ transform: `translateX(${sampleToX(p.sample, p.pxPerSec)}px)` }}
    />
  )
}
