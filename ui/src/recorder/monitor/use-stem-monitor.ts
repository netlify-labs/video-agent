// useStemMonitor: the stem monitor as a hook for the record flow (va-2qq.4.11). Give it the take's AudioContext and
// AudioClock (the capture's), the draft's composition and narration op, and the setup's output and Original audio
// choices; it builds the monitor, loads its stems (`ready`), and `attach(pictureClock)` drives it from the picture:
// start once enough anchors exist, then resync on every anchor. `stop()` when the take stops. The monitor is rebuilt
// (and the old one disposed) when any input changes, so change them only between takes.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NarrationOp, Span } from '../../../../src/lib/timeline'
import type { AudioClock } from '../clock/audio-clock'
import type { PictureClock } from '../clock/picture'
import {
  createStemMonitor,
  type StemMonitor,
  type StemMonitorOptions,
  type StemMonitorStats,
} from './stem-monitor'
import type { MonitorAudio, OutputMode } from './stems'

export interface UseStemMonitorInput {
  context: AudioContext | null
  clock: AudioClock | null
  html: string | null
  op: NarrationOp | null
  audio?: MonitorAudio
  takeSamples: ReadonlyMap<string, number>
  takeSpans?: ReadonlyMap<string, readonly Span[]>
  takeLoader: StemMonitorOptions['takeLoader']
  stemLoader: StemMonitorOptions['stemLoader']
  outputMode: OutputMode
  speakersLevelDb?: number | null
  /** Composition second the take starts at (a punch-in's pre-roll), for what prepare() loads first. */
  from?: number
  destination?: AudioNode
}

const log = (event: string, fields: Record<string, unknown>) => {
  console.info(JSON.stringify({ event, ...fields }))
}

export function useStemMonitor(input: UseStemMonitorInput) {
  const [monitor, setMonitor] = useState<StemMonitor | null>(null)
  const [ready, setReady] = useState(false)
  const loaders = useRef({ take: input.takeLoader, stem: input.stemLoader })
  loaders.current = { take: input.takeLoader, stem: input.stemLoader }
  const {
    context,
    clock,
    html,
    op,
    audio,
    takeSamples,
    takeSpans,
    outputMode,
    speakersLevelDb,
    from,
    destination,
  } = input
  const audioKey = audio ? `${audio.aiVoice.mode}:${audio.aiVoice.volumeDb}:${audio.muteAll ? 1 : 0}` : ''

  useEffect(() => {
    if (!context || !clock || html === null) return
    const m = createStemMonitor({
      context,
      clock,
      html,
      op,
      ...(audio ? { audio } : {}),
      takeSamples,
      ...(takeSpans ? { takeSpans } : {}),
      takeLoader: (id) => loaders.current.take(id),
      stemLoader: (src) => loaders.current.stem(src),
      outputMode,
      ...(speakersLevelDb !== undefined ? { speakersLevelDb } : {}),
      ...(destination ? { destination } : {}),
      log,
    })
    let live = true
    setMonitor(m)
    setReady(false)
    void m.prepare(from ?? 0).then(() => {
      if (live) setReady(true)
    })
    return () => {
      live = false
      m.dispose()
      setMonitor(null)
    }
    // `audio` is compared by value (audioKey): a fresh object with the same choice keeps the monitor.
  }, [
    context,
    clock,
    html,
    op,
    audioKey,
    takeSamples,
    takeSpans,
    outputMode,
    speakersLevelDb,
    from,
    destination,
  ])

  /** Drives the monitor from a picture clock's anchors; returns the unsubscribe. */
  const attach = useCallback(
    (picture: PictureClock) => {
      if (!monitor) return () => undefined
      let started = false
      return picture.onAnchor(() => {
        if (!started) started = monitor.start(picture.anchors) !== null
        else monitor.resync(picture.anchors)
      })
    },
    [monitor],
  )
  const stop = useCallback(() => monitor?.stop(), [monitor])
  const setArmedRange = useCallback((r: Span | null) => monitor?.setArmedRange(r), [monitor])
  const stats = useCallback((): StemMonitorStats | null => monitor?.stats() ?? null, [monitor])

  return { monitor, ready, attach, stop, setArmedRange, stats }
}
