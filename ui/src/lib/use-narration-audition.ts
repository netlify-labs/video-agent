// The narration audition as a hook for the editor (docs/plans/2026-11-02-record-your-own-voiceover.md §5.4): spread
// `previewProps` on <CompositionPreview> and the narration plays in step with it, the iframe's audio levelled by the
// bridge's mix command. The editor's Narration track owns the op; this only listens.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NarrationOp, Span } from '../../../src/lib/timeline'
import { fetchClient } from '../api/client'
import type { PreviewCommand, PreviewMessage, PreviewTransport } from '../components/CompositionPreview'
import { log } from './log'
import { NarrationAudition, type AuditionStats } from './narration-audition'
import { previewMix } from './preview-mix'

/** A take's bytes: its media row's signed file URL, fetched. */
export async function fetchTake(mediaId: string): Promise<ArrayBuffer> {
  const { data } = await fetchClient.GET('/api/v1/media/{id}', { params: { path: { id: mediaId } } })
  if (!data?.urls) throw new Error(`Take ${mediaId} isn't available.`)
  const res = await fetch(data.urls.file)
  if (!res.ok) throw new Error(`Take ${mediaId} didn't download (${res.status}).`)
  return res.arrayBuffer()
}

export interface NarrationAuditionInput {
  /** The narration op being edited; null plays nothing (and leaves the preview's audio as it is). */
  op: NarrationOp | null
  /** Each take's length in samples, as stored. */
  takeSamples: ReadonlyMap<string, number>
  /** Each take's speech-span summary in source samples (for the music's dip). */
  takeSpans?: ReadonlyMap<string, readonly Span[]>
  /** The composition the preview shows (the draft's index.html), for the duck lane. */
  html: string | null
  loadTake?: (mediaId: string) => Promise<ArrayBuffer>
}

export function useNarrationAudition({ op, takeSamples, takeSpans, html, loadTake }: NarrationAuditionInput) {
  const engine = useRef<NarrationAudition | null>(null)
  const load = useRef(loadTake ?? fetchTake)
  load.current = loadTake ?? fetchTake
  useEffect(() => {
    const e = new NarrationAudition({
      loadTake: (id) => load.current(id),
      log,
    })
    engine.current = e
    return () => {
      e.dispose()
      engine.current = null
    }
  }, [])
  useEffect(() => {
    engine.current?.setOp(op, takeSamples)
  }, [op, takeSamples])

  const mix = useMemo(() => (op && html ? previewMix(html, op, takeSpans) : null), [html, op, takeSpans])
  const mixRef = useRef(mix)
  mixRef.current = mix
  const send = useRef<((c: PreviewCommand) => void) | null>(null)
  useEffect(() => {
    // No op: an empty mix gives the composition its own levels back.
    send.current?.({ type: 'mix', tracks: mix ?? {} })
  }, [mix])

  const onReady = useCallback((s: (c: PreviewCommand) => void) => {
    send.current = s
    s({ type: 'mix', tracks: mixRef.current ?? {} })
  }, [])
  const onMessage = useCallback((m: PreviewMessage) => {
    if (m.type === 'time') engine.current?.clock(m.time)
  }, [])
  const onTransport = useCallback((t: PreviewTransport) => {
    const e = engine.current
    if (!e) return
    if (t.type === 'play') void e.play(t.time)
    else if (t.type === 'pause') e.pause()
    else e.seek(t.time)
  }, [])

  const [approxCleanup, setApprox] = useState(false)
  const setApproxCleanup = useCallback((on: boolean) => {
    setApprox(on)
    void engine.current?.setApproxCleanup(on)
  }, [])
  const stats = useCallback((): AuditionStats | null => engine.current?.stats() ?? null, [])

  return { previewProps: { onReady, onMessage, onTransport }, approxCleanup, setApproxCleanup, stats }
}
