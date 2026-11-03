// The takes a narration op places, as the editor needs them (docs/plans/2026-11-02-record-your-own-voiceover.md §5.4,
// §6.1): each one's length in samples, speech spans, waveform peaks (GET /media/{id}/peaks, decoded) and name, fetched
// once per take. A take just uploaded from this page is added with what the upload computed, without a fetch.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { decodePeaks, type Peaks } from '../../../src/lib/peaks'
import { secondsToSamples, type Span } from '../../../src/lib/timeline'
import { fetchClient } from '../api/client'

export interface TakeInfo {
  /** Length in samples at 24 kHz, as the server checks clips against it. */
  samples: number
  /** Speech spans in source samples; null when the take has none stored (it counts as speech throughout). */
  spans: Span[] | null
  peaks: Peaks | null
  name: string
}

/**
 * A take's details. The length is the stored speech summary's (the uploader's count, which the server keeps), else
 * the peaks', else the file's duration, which is what the server falls back to for library audio.
 */
export async function loadTakeInfo(mediaId: string): Promise<TakeInfo> {
  const path = { params: { path: { id: mediaId } } }
  const [media, peaks, speech] = await Promise.all([
    fetchClient.GET('/api/v1/media/{id}', path),
    fetchClient.GET('/api/v1/media/{id}/peaks', { ...path, parseAs: 'arrayBuffer' }),
    fetchClient.GET('/api/v1/media/{id}/speech', path),
  ])
  if (!media.data) throw new Error(`Recording ${mediaId} isn't available.`)
  let decoded: Peaks | null = null
  try {
    decoded = peaks.data ? decodePeaks(new Uint8Array(peaks.data)) : null
  } catch {
    // A damaged waveform only loses the drawing.
  }
  const samples = speech.data?.samples ?? decoded?.samples ?? secondsToSamples(media.data.durationSec ?? 0)
  return {
    samples,
    spans: speech.data ? speech.data.spans.map(([s, e]): Span => [s ?? 0, e ?? 0]) : null,
    peaks: decoded,
    name: media.data.title ?? media.data.filename,
  }
}

export function useNarrationTakes(mediaIds: readonly string[]) {
  const [takes, setTakes] = useState<ReadonlyMap<string, TakeInfo>>(new Map())
  const loading = useRef(new Map<string, Promise<TakeInfo>>())
  const known = useRef(takes)
  known.current = takes

  const add = useCallback((mediaId: string, info: TakeInfo) => {
    loading.current.set(mediaId, Promise.resolve(info))
    setTakes((m) => new Map(m).set(mediaId, info))
  }, [])

  /** The take's details, fetched once (concurrent callers share the request). */
  const ensure = useCallback((mediaId: string): Promise<TakeInfo> => {
    const have = known.current.get(mediaId)
    if (have) return Promise.resolve(have)
    let p = loading.current.get(mediaId)
    if (!p) {
      p = loadTakeInfo(mediaId)
      loading.current.set(mediaId, p)
      p.then(
        (info) => {
          setTakes((m) => new Map(m).set(mediaId, info))
        },
        () => {
          // Asked again next time (a take that was still being checked, a network blip).
          loading.current.delete(mediaId)
        },
      )
    }
    return p
  }, [])

  const key = [...new Set(mediaIds)].sort().join()
  useEffect(() => {
    for (const id of key ? key.split(',') : []) ensure(id).catch(() => undefined)
  }, [key, ensure])

  const maps = useMemo(() => {
    const takeSamples = new Map<string, number>()
    const takeSpans = new Map<string, Span[]>()
    const peaks = new Map<string, Peaks>()
    const names = new Map<string, string>()
    for (const [id, t] of takes) {
      takeSamples.set(id, t.samples)
      if (t.spans) takeSpans.set(id, t.spans)
      if (t.peaks) peaks.set(id, t.peaks)
      names.set(id, t.name)
    }
    return { takeSamples, takeSpans, peaks, names }
  }, [takes])

  return { ...maps, add, ensure }
}
