// LOCKED. Media slots from the beat's props, served from assets/ through staticFile().
import type { CSSProperties } from 'react'
import { Img, OffthreadVideo, staticFile } from 'remotion'
import { assetPath, useBeat } from './context'

function slotOf(slot: string, kind: 'image' | 'video') {
  const m = useBeat().media[slot]
  if (!m || m.kind !== kind) throw new Error(`No ${kind} slot "${slot}" in this beat's props.`)
  return m
}
const fitOf = (fit: 'cover' | 'contain' | null): CSSProperties => (fit ? { objectFit: fit } : {})

export const VaImage = ({ slot, style }: { slot: string; style?: CSSProperties }) => {
  const m = slotOf(slot, 'image')
  return <Img src={staticFile(assetPath(m.src))} style={{ ...style, ...fitOf(m.fit) }} />
}
export const VaClip = ({ slot, style }: { slot: string; style?: CSSProperties }) => {
  const m = slotOf(slot, 'video')
  return <OffthreadVideo muted={!m.hasAudio} src={staticFile(assetPath(m.src))} style={{ ...style, ...fitOf(m.fit) }} />
}
