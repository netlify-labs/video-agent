import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { VaClip } from '../va/Media'
import { VaText } from '../va/Text'

export default function Demo() {
  const f = useCurrentFrame()
  const c = interpolate(f, [0, 18], [0, 1], { extrapolateRight: 'clamp' })
  const s = interpolate(f, [15, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center', textAlign: 'center' }}>
      <div>
        <VaClip slot="hero-clip" style={{ width: 640, height: 360, borderRadius: 16, opacity: c, transform: `scale(${0.9 + 0.1 * c})` }} />
        <VaText id="demo-sub" as="p" style={{ color: 'var(--va-color-muted)', fontSize: 36, marginTop: 20, opacity: s }} />
      </div>
    </AbsoluteFill>
  )
}
