// What a run restores and downloads before it starts (plan v2 §14 rule 21). The server writes it at start time to
// the sources store and pins its sha256 in the prompt, so scripts/prepare-run.ts only ever follows keys the server
// chose: nothing the model writes (or a request smuggles in) can point it somewhere else.
import { createHash } from 'node:crypto'
import { MEDIA_KINDS, type MediaKind } from './media/classify.js'

export const RUN_MANIFEST_VERSION = 1

export type RunKind = 'author' | 'revision' | 'render_unchanged'

export interface RunManifest {
  v: typeof RUN_MANIFEST_VERSION
  jobId: string
  attemptId: string
  versionN: number
  kind: RunKind
  /** The parent version's source archive (revisions). */
  source: { key: string; sha256: string; parentN: number } | null
  /**
   * A version-owned frozen bundle (render-unchanged runs): archive hash plus the canonical file manifest hash. With
   * `revoice`, the run re-speaks those beats' lines and every other file must still match `keptHash` (src/lib/revoice.ts).
   */
  bundle: {
    key: string
    sha256: string
    manifestHash: string
    revoice?: { beats: string[]; keptHash: string } | undefined
  } | null
  /** Library media to download into video/assets/media/ (plan v2 §9, §14 rule 27). */
  media: RunMedia[] | null
  /** Incorporate-feedback runs: the parent MP4 and the pinned comments to make stills of (plan v2 §5). */
  feedback: {
    video: { key: string; sha256: string }
    pins: FeedbackPin[]
  } | null
}

export interface RunMedia {
  /** Key in the media store. */
  key: string
  sha256: string
  /** File name inside video/assets/media/. */
  filename: string
  kind: MediaKind
}

export interface FeedbackPin {
  commentId: string
  timeSec: number
  /** 0–1 within the picture; null for a moment without a spot (still, no dot). */
  x: number | null
  y: number | null
}

/** Where prepare-run writes a pin's still, relative to video/. */
export const feedbackStillPath = (index: number, commentId: string) =>
  `feedback/${String(index + 1).padStart(2, '0')}-${commentId}.jpg`

const MAX_PINS = 50

export const runManifestKey = (jobId: string, attemptId: string) => `${jobId}/runs/${attemptId}.json`

/** Stable bytes: the same inputs always serialize the same, so a re-sent start pins the same hash. */
export function serializeRunManifest(m: RunManifest): string {
  return JSON.stringify({
    v: m.v,
    jobId: m.jobId,
    attemptId: m.attemptId,
    versionN: m.versionN,
    kind: m.kind,
    source: m.source && { key: m.source.key, sha256: m.source.sha256, parentN: m.source.parentN },
    bundle: m.bundle && {
      key: m.bundle.key,
      sha256: m.bundle.sha256,
      manifestHash: m.bundle.manifestHash,
      // Only when there are lines to re-voice, so every other manifest keeps its bytes.
      ...(m.bundle.revoice
        ? { revoice: { beats: [...m.bundle.revoice.beats], keptHash: m.bundle.revoice.keptHash } }
        : {}),
    },
    media:
      m.media && m.media.map((x) => ({ key: x.key, sha256: x.sha256, filename: x.filename, kind: x.kind })),
    feedback: m.feedback && {
      video: { key: m.feedback.video.key, sha256: m.feedback.video.sha256 },
      pins: m.feedback.pins.map((p) => ({ commentId: p.commentId, timeSec: p.timeSec, x: p.x, y: p.y })),
    },
  })
}

export const sha256Hex = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')

const HEX = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9_-]{1,80}$/

/** Parses and checks a downloaded manifest against the attempt and the hash from the prompt. Throws a message. */
export function verifyRunManifest(raw: string, expected: { attemptId: string; sha256: string }): RunManifest {
  if (sha256Hex(raw) !== expected.sha256)
    throw new Error("The run manifest doesn't match the hash in your prompt.")
  let m: Omit<RunManifest, 'v'> & { v: unknown }
  try {
    m = JSON.parse(raw) as typeof m
  } catch {
    throw new Error('The run manifest is not valid JSON.')
  }
  if (m.v !== RUN_MANIFEST_VERSION) throw new Error(`Unsupported run manifest version ${String(m.v)}.`)
  if (m.attemptId !== expected.attemptId) throw new Error('The run manifest is for a different attempt.')
  if (!ID.test(m.jobId) || !ID.test(m.attemptId)) throw new Error('The run manifest has a bad id.')
  if (!['author', 'revision', 'render_unchanged'].includes(m.kind)) throw new Error('Unknown run kind.')
  // Every key stays inside this video's own prefix.
  const own = (key: string) => key.startsWith(`${m.jobId}/`) && !key.includes('..') && !key.includes('//')
  if (m.source && (!own(m.source.key) || !HEX.test(m.source.sha256)))
    throw new Error('The run manifest has a bad source entry.')
  if (m.bundle && (!own(m.bundle.key) || !HEX.test(m.bundle.sha256) || !HEX.test(m.bundle.manifestHash)))
    throw new Error('The run manifest has a bad bundle entry.')
  const rv = m.bundle?.revoice
  if (
    rv !== undefined &&
    (!rv ||
      !HEX.test(rv.keptHash) ||
      !Array.isArray(rv.beats) ||
      rv.beats.length === 0 ||
      rv.beats.length > 100 ||
      !rv.beats.every((b) => typeof b === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(b)))
  )
    throw new Error('The run manifest has a bad re-voice entry.')
  if (m.media) {
    if (!Array.isArray(m.media) || m.media.length > 50) throw new Error('The run manifest has bad media.')
    for (const x of m.media)
      if (
        !/^med_[a-z0-9]{8,40}\/(original|clean)\.[a-z0-9]{2,5}$/.test(x.key) ||
        !HEX.test(x.sha256) ||
        !/^med_[a-z0-9]{8,40}\.[a-z0-9]{2,5}$/.test(x.filename) ||
        !(MEDIA_KINDS as readonly string[]).includes(x.kind)
      )
        throw new Error('The run manifest has a bad media entry.')
  }
  if (m.feedback) {
    const f = m.feedback
    if (!own(f.video.key) || !HEX.test(f.video.sha256))
      throw new Error('The run manifest has a bad feedback video.')
    if (!Array.isArray(f.pins) || f.pins.length > MAX_PINS)
      throw new Error('The run manifest has bad feedback pins.')
    const unit = (n: unknown) => n === null || (typeof n === 'number' && n >= 0 && n <= 1)
    for (const p of f.pins)
      if (
        !ID.test(p.commentId) ||
        !(typeof p.timeSec === 'number' && p.timeSec >= 0) ||
        !unit(p.x) ||
        !unit(p.y)
      )
        throw new Error('The run manifest has a bad feedback pin.')
  }
  if (m.kind === 'revision' && !m.source) throw new Error('A revision run needs a source.')
  if (m.kind === 'render_unchanged' && !m.bundle) throw new Error('A render-unchanged run needs a bundle.')
  return m as RunManifest
}
