import type { CSSProperties } from 'react'
import { AbsoluteFill, Audio, Sequence, Series, staticFile } from 'remotion'
import { beats, layers } from '../registry'
import { assetPath, BeatContext } from './context'
import { layout } from './layout'
import type { VaProps } from './schema'

export const VaVideo = (props: VaProps) => {
  const lay = layout(props.beats)
  const vars = Object.fromEntries(Object.entries(props.colors).map(([k, v]) => [`--va-color-${k}`, v])) as CSSProperties
  const music = props.audio.music
  return (
    <AbsoluteFill style={{ ...vars, background: 'var(--va-color-bg)', fontFamily: 'system-ui, sans-serif' }}>
      {props.layers.map((l) => {
        const L = layers[l.id]
        return L ? <L key={l.id} /> : null
      })}
      {music && !music.muted ? <Audio src={staticFile(assetPath(music.src))} volume={music.volume} /> : null}
      <Series>
        {props.beats.map((b, i) => {
          const B = beats[b.id]
          if (!B) throw new Error(`No component for beat "${b.id}" in src/registry.ts.`)
          return (
            <Series.Sequence key={b.id} durationInFrames={lay.beats[i]?.frames ?? 1} name={b.id}>
              <BeatContext.Provider value={b}>
                <B />
                {b.voice && !b.voice.muted ? (
                  <Sequence from={Math.round(b.voice.start * 30)} durationInFrames={Math.max(1, Math.round(b.voice.duration * 30))}>
                    <Audio src={staticFile(assetPath(b.voice.src))} volume={b.voice.volume} />
                  </Sequence>
                ) : null}
              </BeatContext.Provider>
            </Series.Sequence>
          )
        })}
      </Series>
    </AbsoluteFill>
  )
}
