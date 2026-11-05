import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { VaImage } from '../va/Media'
import { VaText } from '../va/Text'

export default function Outro() {
  const f = useCurrentFrame()
  const t = interpolate(f, [6, 24], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center', textAlign: 'center' }}>
      <div>
        <VaImage slot="logo" style={{ width: 200, height: 80 }} />
        <VaText id="outro-cta" as="h2" style={{ color: 'var(--va-color-text)', fontSize: 96, fontWeight: 700, marginTop: 16, opacity: t, transform: `scale(${0.96 + 0.04 * t})` }} />
      </div>
    </AbsoluteFill>
  )
}
