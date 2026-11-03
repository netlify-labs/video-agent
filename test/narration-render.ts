// A keep-visuals render of recorded narration, as the finalize, outputs and caption-revision tests need it: a ready,
// editable v1, takes for it, a draft whose narration plays them, and what the fake run reports for the render.
import { readFileSync } from 'node:fs'

import type { NarrationReport } from '../src/domain/types.js'
import { sha256Hex } from '../src/lib/crypto.js'
import { SAMPLE_RATE } from '../src/lib/timeline.js'
import { wav } from '../src/lib/voice.js'
import { PROMPT, upload, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

export const S = SAMPLE_RATE
const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
export const tone = () => new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
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

/** A composition that keeps editing contract v1 (9 s: intro, demo, outro), as the next fake run's source. */
export const contractSource = () =>
  tarGz([
    { name: 'video/index.html', body: fx('index.html') },
    { name: 'video/summary.json', body: fx('summary.json') },
  ])

/** A ready, editable v1, n takes for it and a draft whose narration plays them. */
export async function narratedDraft(h: Harness, n = 2) {
  h.deps.nextSource = contractSource()
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  const id = v.id as string
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const m = await h.json<{ id: string }>(await upload(h, h.member, tone(), 'filename=take.mp3'))
    await h.deps.store.updateMedia(m.id, { role: 'narration-take', scopeJobId: id, durationSec: 20 })
    ids.push(m.id)
  }
  const op = narrationOp(ids)
  const editId = await draftNarration(h, id, 1, op)
  return { id, editId, ids: [...ids].sort(), op }
}

/** The narration op playing each take's first second, two seconds apart (from `at` seconds). */
export const narrationOp = (ids: string[], at = 1) => ({
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips: ids.map((mediaId, i) => ({
    id: `c${i}`,
    mediaId,
    srcStart: 0,
    srcEnd: S,
    fit: { a: 0, b: 1 / S, residualMs: 0 },
    offsetSamples: 0,
    start: (at + 2 * i) * S,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
  })),
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'light',
})

/** A draft on version `fromN` whose narration is `op`; returns its id. */
export async function draftNarration(h: Harness, id: string, fromN: number, op: object) {
  const e = await h.json<{ id: string; rev?: number }>(
    await h.call('POST', `/api/v1/videos/${id}/versions/${fromN}/edits`, { as: h.member }),
  )
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
