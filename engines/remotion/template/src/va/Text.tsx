// LOCKED. Every on-screen text comes from the beat's props, so an edit changes data, not markup.
import { createElement, type CSSProperties } from 'react'
import { useBeat } from './context'

export const VaText = ({ id, as = 'div', style }: { id: string; as?: string; style?: CSSProperties }) => {
  const t = useBeat().texts[id]
  if (!t) throw new Error(`No text "${id}" in this beat's props.`)
  return createElement(as, { style, 'data-va-text': id }, t.text)
}
