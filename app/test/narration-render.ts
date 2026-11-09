// A keep-visuals render of recorded narration, as the finalize, outputs and caption-revision tests need it: a ready,
// editable v1, takes for it, a draft whose narration plays them, and what the fake run reports for the render.
import type { NarrationReport } from '../server/domain/types.js'
import { sha256Hex } from '../server/lib/crypto.js'
import { SAMPLE_RATE } from '../server/lib/timeline.js'
import { wav } from '../server/lib/voice.js'
import { editableVideo, narrationTake, type Harness } from './helpers.js'

export const S = SAMPLE_RATE
/** The processed bus the fake run uploads: 9 s of 24 kHz mono PCM16. */
export const BUS = wav(new Uint8Array(9 * S * 2).map((_, i) => i % 7))

export const report = (over: Partial<NarrationReport> = {}): NarrationReport => ({
  pipeline: 1,
  cleanup: 'light',
  ffmpeg: 'ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers',
  bus: { sha256: sha256Hex(BUS), samples: 9 * S },
  stt: { status: 'ok', provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3', words: 12 },
  ...over,
})

/** A ready, editable v1, n takes for it and a draft whose narration plays them. */
export async function narratedDraft(h: Harness, n = 2) {
  const id = await editableVideo(h)
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await narrationTake(h, id))
  const op = narrationOp(ids)
  const editId = await draftNarration(h, id, 1, op)
  return { id, editId, ids: [...ids].sort(), op }
}

/** One narration clip: its take's first 2 s, at 1 s; `over` replaces any field. */
export const narrationClip = (mediaId: string, over: Record<string, unknown> = {}) => ({
  id: 'c1',
  mediaId,
  srcStart: 0,
  srcEnd: 2 * S,
  fit: { a: 0, b: 1 / S, residualMs: 0 },
  offsetSamples: 0,
  start: S,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...over,
})
/** A narration op playing `clips` on the default mix; `over` replaces any top-level field. */
export const narrationTrack = <C extends object>(clips: C[], over: Record<string, unknown> = {}) => ({
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips,
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'light',
  ...over,
})

/** The narration op playing one take's first 2 s, at `start` samples. */
export const narrationAt = (mediaId: string, start = S) => narrationTrack([narrationClip(mediaId, { start })])

/** The narration op playing each take's first second, two seconds apart (from `at` seconds). */
export const narrationOp = (ids: string[], at = 1) =>
  narrationTrack(
    ids.map((mediaId, i) => narrationClip(mediaId, { id: `c${i}`, srcEnd: S, start: (at + 2 * i) * S })),
  )

/** A draft on version `fromN` whose narration is `op`; returns its id. */
export async function draftNarration(h: Harness, id: string, fromN: number, op: object) {
  const e = await h.json<{ id: string; rev?: number }>(
    await h.call('POST', `/api/v1/videos/${id}/versions/${fromN}/edits`, { as: h.member }),
  )
  // Saving narration needs the video's narration lock (plan §2.7); take it just before, since driving runs moves the
  // test clock past its 2-minute hold.
  const lock = await h.call('POST', `/api/v1/videos/${id}/narration-lock`, {
    as: h.member,
    body: { draftId: e.id },
  })
  if (lock.status !== 200) throw new Error(`narration lock: ${lock.status} ${await lock.text()}`)
  const res = await h.call('PUT', `/api/v1/edits/${e.id}`, {
    as: h.member,
    body: { rev: e.rev ?? 0, ops: [op] },
  })
  if (res.status !== 200) throw new Error(`draft save: ${res.status} ${await res.text()}`)
  return e.id
}

export const render = (h: Harness, editId: string) =>
  h.call('POST', `/api/v1/edits/${editId}/render`, { as: h.member })
/** The draft lets go of its takes, so only the attempt holds them (and a release starts their 30 days). */
export const dropDraftRefs = (h: Harness, editId: string) => h.deps.store.deleteMediaRefs('draft', editId)
