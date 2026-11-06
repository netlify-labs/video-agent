// usePictureClock: the picture clock as a hook for the record flow (va-2qq.4.11) and the monitor (va-2qq.4.7). Give
// it the parent-document <video muted> playing the base MP4; `start()` (inside the Record click, after
// AudioContext.resume()) arms a fresh PictureClock for one take, `beginTake()` attaches the recorder's first captured
// frame, and `fitFor()` is the take's final piecewise fit after stop. Stop listeners registered with `onStop` hear
// every take's stop. React state is only the stop reason and a throttled anchor count; the anchors themselves are the
// live array on the clock.
import { useCallback, useEffect, useRef, useState } from 'react'
import { log } from '../../lib/log'
import type { AudioClock } from './audio-clock'
import type { StopKind, StopReason } from './fit'
import {
  PictureClock,
  type Anchor,
  type PictureClockOptions,
  type TakeClockInput,
  type TakeFit,
} from './picture'

export interface UsePictureClockOptions extends Omit<
  PictureClockOptions,
  'audioClock' | 'doc' | 'mediaDevices'
> {
  audioClock?: AudioClock | null
}

const NO_ANCHORS: readonly Anchor[] = []

export function usePictureClock(videoEl: HTMLVideoElement | null, options: UsePictureClockOptions = {}) {
  const clock = useRef<PictureClock | null>(null)
  const opts = useRef(options)
  opts.current = options
  const listeners = useRef(new Set<(r: StopReason) => void>())
  const [stopReason, setStopReason] = useState<StopReason | null>(null)
  const [anchorCount, setAnchorCount] = useState(0)

  const dispose = useCallback(() => {
    clock.current?.dispose()
    clock.current = null
  }, [])
  useEffect(() => dispose, [dispose, videoEl])

  /** Arms a new clock for one take (the previous one is disposed). */
  const start = useCallback(
    (overrides: Partial<UsePictureClockOptions> = {}): PictureClock | null => {
      if (!videoEl) return null
      dispose()
      const o = { ...opts.current, ...overrides }
      const c = new PictureClock(videoEl, {
        log,
        ...o,
        doc: document,
        // Undefined on insecure origins.
        mediaDevices: 'mediaDevices' in navigator ? navigator.mediaDevices : null,
      })
      let last = 0
      c.onAnchor(() => {
        const now = performance.now()
        if (now - last < 250) return
        last = now
        setAnchorCount(c.anchors.length)
      })
      c.onStop((r) => {
        setAnchorCount(c.anchors.length)
        setStopReason(r)
        for (const l of listeners.current) l(r)
      })
      setStopReason(null)
      setAnchorCount(0)
      clock.current = c
      return c.start()
    },
    [videoEl, dispose],
  )

  const beginTake = useCallback((input: TakeClockInput) => clock.current?.beginTake(input), [])
  const stop = useCallback(
    (kind: StopKind = 'user', detail?: string) => clock.current?.stop(kind, detail),
    [],
  )
  const fitFor = useCallback(
    (recording?: TakeClockInput, endSample?: number): TakeFit | null =>
      clock.current ? clock.current.fitFor(recording ?? undefined, endSample) : null,
    [],
  )
  const onStop = useCallback((fn: (r: StopReason) => void) => {
    listeners.current.add(fn)
    return () => {
      listeners.current.delete(fn)
    }
  }, [])

  return {
    /** The current take's anchors (a live array: read it, don't keep it). */
    get anchors(): readonly Anchor[] {
      return clock.current?.anchors ?? NO_ANCHORS
    },
    anchorCount,
    stopReason,
    clock: clock.current,
    start,
    beginTake,
    stop,
    fitFor,
    onStop,
  }
}
