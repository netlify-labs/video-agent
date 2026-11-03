// The setup panel's live mic (plan 2026-11-02 §5.1): opens the chosen input with the take's own constraints (so the
// meter hears what the take will), runs it through an AnalyserNode, and reports RMS and peak in dBFS about 20 times a
// second with a clip light latched for 1 s. check() runs the 3 s level check over the same readings. The mic is only
// opened by open() (the "Check mic" click), and released by close() and on unmount.
import { useCallback, useEffect, useRef, useState } from 'react'
import { micStream } from '../recorder'
import {
  CHECK_MS,
  CLIP_DB,
  CLIP_LATCH_MS,
  FLOOR_DB,
  levelVerdict,
  measure,
  toDb,
  type Verdict,
} from './level'
import { micProblem, type MicProblem } from './mic'
import type { Level } from '../recorder'

export interface MeterReading {
  rmsDb: number
  peakDb: number
  clip: boolean
}

export interface LevelCheck {
  verdict: Verdict
  rmsDb: number
  peakDb: number
}

export type PreviewState =
  | { status: 'idle' }
  | { status: 'opening' }
  | { status: 'live'; deviceId: string; label: string }
  | { status: 'problem'; problem: MicProblem }

const SILENT: MeterReading = { rmsDb: FLOOR_DB, peakDb: FLOOR_DB, clip: false }
const UPDATE_MS = 50

export function useMicPreview() {
  const [state, setState] = useState<PreviewState>({ status: 'idle' })
  const [reading, setReading] = useState<MeterReading>(SILENT)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<LevelCheck | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const nodes = useRef<AudioNode[]>([])
  const raf = useRef(0)
  const readings = useRef<Level[] | null>(null)
  const checkEnd = useRef(0)
  const clipUntil = useRef(0)
  const seq = useRef(0)

  const release = useCallback(() => {
    cancelAnimationFrame(raf.current)
    for (const n of nodes.current) n.disconnect()
    nodes.current = []
    for (const t of stream.current?.getTracks() ?? []) t.stop()
    stream.current = null
    readings.current = null
    setChecking(false)
    setReading(SILENT)
  }, [])

  const close = useCallback(() => {
    seq.current++
    release()
    setState({ status: 'idle' })
  }, [release])

  /** Opens (or reopens) the mic; resolves with the state it ended in. */
  const open = useCallback(
    async (o: { deviceId: string | null; echoCancellation: boolean }): Promise<PreviewState> => {
      const n = ++seq.current
      release()
      setState({ status: 'opening' })
      setResult(null)
      const fail = (problem: MicProblem): PreviewState => {
        const s: PreviewState = { status: 'problem', problem }
        if (n === seq.current) setState(s)
        return s
      }
      // Outside a secure context there's no navigator.mediaDevices at all.
      if (!import.meta.env.VITE_MOCK && !(navigator.mediaDevices as MediaDevices | undefined))
        return fail('insecure')
      try {
        const c = (ctx.current ??= new AudioContext({ latencyHint: 'interactive' }))
        await c.resume().catch(() => undefined)
        let s: MediaStream
        try {
          s = await micStream(c, {
            ...(o.deviceId ? { deviceId: o.deviceId } : {}),
            echoCancellation: o.echoCancellation,
          })
        } catch (e) {
          // A remembered mic that's gone: the default one instead.
          if (!o.deviceId || micProblem(e) !== 'missing') throw e
          s = await micStream(c, { echoCancellation: o.echoCancellation })
        }
        if (n !== seq.current) {
          for (const t of s.getTracks()) t.stop()
          return { status: 'idle' }
        }
        const track = s.getAudioTracks()[0]
        if (!track) {
          for (const t of s.getTracks()) t.stop()
          return fail('missing')
        }
        stream.current = s
        const src = c.createMediaStreamSource(s)
        const analyser = c.createAnalyser()
        analyser.fftSize = 2048
        // Some browsers only run an analyser that reaches the destination: through a silent gain.
        const silent = c.createGain()
        silent.gain.value = 0
        src.connect(analyser).connect(silent).connect(c.destination)
        nodes.current = [src, analyser, silent]
        const buf = new Float32Array(analyser.fftSize)
        let last = 0
        const tick = (now: number) => {
          analyser.getFloatTimeDomainData(buf)
          const l = measure(buf)
          readings.current?.push(l)
          const peakDb = toDb(l.peak)
          if (peakDb >= CLIP_DB) clipUntil.current = now + CLIP_LATCH_MS
          if (readings.current && now >= checkEnd.current) {
            setResult(levelVerdict(readings.current))
            readings.current = null
            setChecking(false)
          }
          if (now - last >= UPDATE_MS) {
            last = now
            setReading({ rmsDb: toDb(l.rms), peakDb, clip: now < clipUntil.current })
          }
          raf.current = requestAnimationFrame(tick)
        }
        raf.current = requestAnimationFrame(tick)
        const settings = track.getSettings()
        const live: PreviewState = {
          status: 'live',
          deviceId: settings.deviceId ?? o.deviceId ?? '',
          label: track.label,
        }
        setState(live)
        return live
      } catch (e) {
        if (n !== seq.current) return { status: 'idle' }
        release()
        return fail(micProblem(e))
      }
    },
    [release],
  )

  const check = useCallback(() => {
    if (!stream.current) return
    setResult(null)
    readings.current = []
    checkEnd.current = performance.now() + CHECK_MS
    setChecking(true)
  }, [])

  useEffect(
    () => () => {
      seq.current++
      release()
      void ctx.current?.close().catch(() => undefined)
      ctx.current = null
    },
    [release],
  )

  return { state, reading, checking, result, open, close, check, stream }
}
