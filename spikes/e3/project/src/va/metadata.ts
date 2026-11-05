import type { CalculateMetadataFunction } from 'remotion'
import { layout } from './layout'
import type { VaProps } from './schema'

export const vaMetadata: CalculateMetadataFunction<VaProps> = ({ props }) => ({
  durationInFrames: Math.max(1, layout(props.beats).totalFrames),
  width: props.width,
  height: props.height,
  fps: 30,
})
