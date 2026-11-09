// LOCKED. The whole video: colours as --va-color-* on the root, the layers, the music, and the beats back to back in
// props order, each found through the generated src/registry.ts.
import type { CSSProperties } from 'react'
import { AbsoluteFill, Series } from 'remotion'
import { beats, layers } from '../registry'
import { VaMusic } from './Audio'
import { BeatContext } from './context'
import { layout } from './layout'
import type { VaProps } from './schema'

export const VaVideo = (props: VaProps) => {
  const lay = layout(props.beats)
  const vars = Object.fromEntries(Object.entries(props.colors).map(([k, v]) => [`--va-color-${k}`, v])) as CSSProperties
  return (
    <AbsoluteFill style={{ ...vars, background: 'var(--va-color-bg)', fontFamily: 'system-ui, sans-serif' }}>
      {props.layers.map((l) => {
        const L = layers[l.id]
        if (!L) throw new Error(`No component for layer "${l.id}" in src/registry.ts.`)
        return <L key={l.id} />
      })}
      {props.audio.music ? <VaMusic music={props.audio.music} /> : null}
      <Series>
        {props.beats.map((b, i) => {
          const B = beats[b.id]
          if (!B) throw new Error(`No component for beat "${b.id}" in src/registry.ts.`)
          return (
            <Series.Sequence key={b.id} durationInFrames={lay.beats[i]?.frames ?? 1} name={b.id}>
              <BeatContext.Provider value={b}>
                <B />
              </BeatContext.Provider>
            </Series.Sequence>
          )
        })}
      </Series>
    </AbsoluteFill>
  )
}
