import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { VaText } from '../va/Text'

const ease = (f: number, from: number, dur: number) =>
  interpolate(f, [from * 30, (from + dur) * 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })

export default function Intro() {
  const f = useCurrentFrame()
  const k = ease(f, 0.2, 0.5)
  const t = ease(f, 0.4, 0.6)
  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center', textAlign: 'center' }}>
      <div>
        <VaText id="intro-kicker" style={{ color: 'var(--va-color-accent)', fontSize: 28, letterSpacing: '0.18em', textTransform: 'uppercase', opacity: k, transform: `translateY(${(1 - k) * 16}px)` }} />
        <VaText id="intro-title" as="h1" style={{ color: 'var(--va-color-text)', fontSize: 96, fontWeight: 700, marginTop: 16, opacity: t, transform: `translateY(${(1 - t) * 24}px)` }} />
      </div>
    </AbsoluteFill>
  )
}
