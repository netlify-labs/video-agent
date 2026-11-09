// LOCKED. The music layer (Phase 2): its level, mute and fades. Per-beat effects and voice arrive in Phase 4.
import { Audio, interpolate, staticFile, useVideoConfig } from 'remotion'
import { assetPath } from './context'
import type { VaProps } from './schema'

export const VaMusic = ({ music }: { music: NonNullable<VaProps['audio']['music']> }) => {
  const { durationInFrames, fps } = useVideoConfig()
  if (music.muted) return null
  const fadeIn = Math.max(1, Math.round(music.fadeIn * fps))
  const fadeOut = Math.max(1, Math.round(music.fadeOut * fps))
  return (
    <Audio
      src={staticFile(assetPath(music.src))}
      volume={(f) =>
        music.volume *
        Math.min(
          interpolate(f, [0, fadeIn], [0, 1], { extrapolateRight: 'clamp' }),
          interpolate(f, [durationInFrames - fadeOut, durationInFrames], [1, 0], { extrapolateLeft: 'clamp' }),
        )
      }
    />
  )
}
