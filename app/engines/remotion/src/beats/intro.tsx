import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { VaText } from '../va/Text'

export default function Intro() {
  const f = useCurrentFrame()
  const t = interpolate(f, [12, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <VaText
        id="intro-title"
        as="h1"
        style={{ color: 'var(--va-color-text)', fontSize: 120, fontWeight: 700, opacity: t, transform: `translateY(${(1 - t) * 24}px)` }}
      />
    </AbsoluteFill>
  )
}
