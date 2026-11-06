import type { CSSProperties } from 'react'
import { Img, OffthreadVideo, staticFile } from 'remotion'
import { assetPath, useBeat } from './context'

function slotOf(slot: string, kind: 'image' | 'video') {
  const m = useBeat().media[slot]
  if (!m || m.kind !== kind) throw new Error(`No ${kind} slot "${slot}" in this beat's props.`)
  return m
}
export const VaImage = ({ slot, style }: { slot: string; style?: CSSProperties }) => {
  const m = slotOf(slot, 'image')
  return <Img src={staticFile(assetPath(m.src))} style={{ ...style, ...(m.fit ? { objectFit: m.fit as CSSProperties['objectFit'] } : {}) }} />
}
export const VaClip = ({ slot, style }: { slot: string; style?: CSSProperties }) => {
  const m = slotOf(slot, 'video')
  return <OffthreadVideo muted src={staticFile(assetPath(m.src))} style={{ ...style, ...(m.fit ? { objectFit: m.fit as CSSProperties['objectFit'] } : {}) }} />
}
