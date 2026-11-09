// What a run restores and downloads before it starts (plan v2 §14 rule 21). The server writes it at start time to
// the sources store and pins its sha256 in the prompt, so scripts/prepare-run.ts only ever follows keys the server
// chose: nothing the model writes (or a request smuggles in) can point it somewhere else.
import { createHash } from 'node:crypto'
import { isEngineId, type EngineId } from '../domain/engines.js'
import { LOOK_ID } from './looks.js'
import { isBundleReference, type BundleReference } from './bundle-references.js'
import { isLanguage, type Language } from './language.js'
import { MEDIA_KINDS, type MediaKind } from './media/classify.js'
import type { RedactEntry } from './recording-trace.js'
import {
  GAIN_DB_RANGE,
  MAX_NARRATION_CLIPS,
  MAX_NARRATION_TAKES,
  MAX_OUTPUT_SAMPLES,
  NARRATION_CLEANUP_PRESETS,
  SAMPLE_RATE,
  type NarrationCleanup,
  type NarrationOp,
} from './timeline.js'

export const RUN_MANIFEST_VERSION = 1

/**
 * author_from_frozen: an authoring run that starts from a frozen edited draft instead of a parent's archive (fit the
 * video to my narration, plan 2026-11-02 §6.4). It carries the bundle and its narration like render_unchanged, but
 * the agent may change the visuals; the narration stays locked (app/server/lib/narration-modified.ts).
 */
export type RunKind = 'author' | 'revision' | 'render_unchanged' | 'author_from_frozen'

export const RUN_KINDS: readonly RunKind[] = ['author', 'revision', 'render_unchanged', 'author_from_frozen']

export interface RunCallback {
  token: string
}

export interface RunManifest {
  v: typeof RUN_MANIFEST_VERSION
  jobId: string
  attemptId: string
  versionN: number
  kind: RunKind
  /**
   * The parent version's source archive (revisions), with its reference files (the narration bus) to fetch into
   * video/ by key from the videos store (app/server/lib/bundle-references.ts).
   */
  /** parentN is null for a remix: its source is the copy of another video's composition (remix spec §3.2). */
  source: {
    key: string
    sha256: string
    parentN: number | null
    references?: BundleReference[] | undefined
  } | null
  /**
   * A version-owned frozen bundle (render-unchanged and author-from-frozen runs): archive hash plus the canonical file
   * manifest hash. With
   * `revoice`, the run re-speaks those beats' lines and every other file must still match `keptHash` (app/server/lib/revoice.ts).
   * `references` are restored like the source's, before the manifest hash is checked.
   */
  bundle: {
    key: string
    sha256: string
    manifestHash: string
    revoice?: { beats: string[]; keptHash: string } | undefined
    references?: BundleReference[] | undefined
    /** Recorded narration to mix (keep-visuals and fit renders): prepare-run hydrates its takes outside video/. */
    narration?: FrozenNarration | undefined
    /** Hold stills the run adds (recording.ts emit --holds-only); render-job leaves them out of the hash. */
    recordingHolds?: string[] | undefined
  } | null
  /** Library media to download into video/assets/media/ (plan v2 §9, §14 rule 27). */
  media: RunMedia[] | null
  /** Incorporate-feedback runs: the parent MP4 and the pinned comments to make stills of (plan v2 §5). */
  feedback: {
    video: { key: string; sha256: string }
    pins: FeedbackPin[]
  } | null
  /**
   * The render engine (render-engines plan §4.2). Absent means HyperFrames, so the server writes it only for other
   * engines and every HyperFrames manifest keeps its bytes. `tier` and `development` are Remotion's alone: the license
   * tier picks the key the render reports with, and `development` marks a test deployment's renders.
   */
  engine?: RunEngine | undefined
  /**
   * The attempt's callback token when the deployment has no VIDEO_AGENT_RUN_SECRET (app/server/lib/run-auth.ts), here and
   * nowhere in the prompt or a command line. prepare-run moves it to .va-run/callback.json (mode 0600, never archived or
   * uploaded) for render-job and checkpoint, and leaves it out of .render/run-manifest.json.
   */
  callback?: RunCallback | undefined
  /**
   * A scoped revision (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.3): only these beats may change.
   * The stills of their neighbours come from `feedback.video` (with no pins when nothing was commented).
   */
  scope?: RunScope | undefined
  /**
   * The video's look (plan 2026-11-04-looks §4.6): its snapshot in the sources store, which prepare-run unpacks into
   * context/look/ and checks against `hash`. Absent with no look, so every other manifest keeps its bytes.
   */
  look?: RunLook | undefined
  /**
   * A demo made from a screen recording (screen-recording plan §5.5): the recording is one of `media` (same key,
   * sha256 and filename); its frozen pointer trace, the person's setup boxes and trim go to .va-run/recording/<id>/.
   */
  recording?: RunRecording | undefined
}

export interface RunRecording {
  mediaId: string
  key: string
  sha256: string
  filename: string
  trace?: { key: string; sha256: string } | undefined
  /** The person's setup boxes: one-key hidden areas. */
  boxes: RedactEntry[]
  trim?: [number, number] | undefined
  /** Made by recording.ts compose, with no agent (the Quick demo). */
  compose?: boolean | undefined
  /** Privacy mode: find private things and hide them (the agent confirms each). */
  privacy?: boolean | undefined
  /** Text the person asked to hide wherever it shows, privacy mode or not. */
  hideStrings?: string[] | undefined
}

export const MAX_SETUP_BOXES = 200

/** Whether a parsed manifest's recording block has the shape the server writes, and names one of its media. */
function isRecording(raw: unknown, media: RunMedia[] | null): boolean {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  const id = r.mediaId
  if (typeof id !== 'string' || !MEDIA_ID.test(id)) return false
  const matches = (media ?? []).filter(
    (x) => x.kind === 'video' && x.key === r.key && x.sha256 === r.sha256 && x.filename === r.filename,
  )
  if (matches.length !== 1 || !String(r.key).startsWith(`${id}/`)) return false
  if (r.trace !== undefined) {
    const t = r.trace as Record<string, unknown> | null
    if (!t || t.key !== `${id}/trace.json` || typeof t.sha256 !== 'string' || !HEX.test(t.sha256))
      return false
  }
  if (!Array.isArray(r.boxes) || r.boxes.length > MAX_SETUP_BOXES) return false
  const frac = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  const secs = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0
  for (const b of r.boxes as unknown[]) {
    const e = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
    const keys = e.boxes
    if (
      !secs(e.start) ||
      !secs(e.end) ||
      (e.end as number) < (e.start as number) ||
      typeof e.reason !== 'string' ||
      !Array.isArray(keys) ||
      keys.length !== 1
    )
      return false
    const k = keys[0] as unknown
    if (!Array.isArray(k) || k.length !== 5 || !secs(k[0]) || !k.slice(1).every(frac)) return false
    if ((k[1] as number) + (k[3] as number) > 1 + 1e-9 || (k[2] as number) + (k[4] as number) > 1 + 1e-9)
      return false
  }
  if (r.trim !== undefined) {
    const t = r.trim
    if (
      !Array.isArray(t) ||
      t.length !== 2 ||
      !secs(t[0]) ||
      !secs(t[1]) ||
      !((t[0] as number) < (t[1] as number))
    )
      return false
  }
  if (r.compose !== undefined && typeof r.compose !== 'boolean') return false
  if (r.privacy !== undefined && typeof r.privacy !== 'boolean') return false
  if (
    r.hideStrings !== undefined &&
    !(
      Array.isArray(r.hideStrings) &&
      r.hideStrings.length <= 50 &&
      r.hideStrings.every((s) => typeof s === 'string' && s.length <= 200)
    )
  )
    return false
  return true
}

export interface RunLook {
  id: string
  /** '<jobId>/looks/<hash>.tar.gz' in the sources store. */
  key: string
  sha256: string
  /** lookHash of the unpacked files (app/server/lib/looks.ts). */
  hash: string
}

export interface RunScope {
  beats: string[]
  /** Stills from the parent MP4 so the agent can match the neighbours, relative to video/. Empty: no stills. */
  stills: ScopeStill[]
}

export interface ScopeStill {
  atSec: number
  path: string
  what: 'before' | 'after'
  beat: string
}

export interface RunEngine {
  id: EngineId
  tier?: 'free' | 'company' | undefined
  development?: true | undefined
}

/** The engine a manifest names: HyperFrames when it names none. */
export const runEngineId = (m: Pick<RunManifest, 'engine'>): EngineId => m.engine?.id ?? 'hyperframes'

/** The most bytes the takes one render freezes may add up to (plan 2026-11-02 §6.1); at most MAX_NARRATION_TAKES. */
export const MAX_FROZEN_TAKE_BYTES = 400 * 1024 * 1024

export type CaptionPolicy = 'sidecar' | 'burned'

/** How the run transcribes the bus for captions (the admin setting at freeze time; app/server/domain/types.ts). */
export type FrozenTranscription = 'local' | 'elevenlabs' | 'off'

/** One take a render mixes: its bytes in the media store by key and digest, never snapshotted into the bundle. */
export interface FrozenTake {
  mediaId: string
  key: string
  sha256: string
  bytes: number
  /** Library audio used as narration keeps its licence slug (cc0, by); recordings have none. */
  license?: string | undefined
}

/**
 * Recorded narration as a render freezes it (plan 2026-11-02 §6.1, §6.3): the resolved op (only audible clips), the
 * takes those clips play, the processing recipe, the bus length to mix in samples and the caption policy.
 */
export interface FrozenNarration {
  op: NarrationOp
  takes: FrozenTake[]
  recipe: { pipeline: number; cleanup: NarrationCleanup }
  targetSamples: number
  captions: CaptionPolicy
  /** The transcription provider (plan §6.6). Missing (frozen before it was recorded): 'local'. */
  transcriptionProvider?: FrozenTranscription | undefined
  /** The video's language, transcribed in (app/server/lib/language.ts). Missing (frozen before it was recorded): 'en'. */
  language?: Language | undefined
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
export const MAX_SCOPE_BEATS = 20
export const MAX_SCOPE_STILLS = 40
const BEAT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/
const SCOPE_STILL = /^feedback\/scope\/[a-z0-9][a-z0-9-]{0,40}-(before|after)\.jpg$/

/** Where prepare-run writes a scope still, relative to video/ (feedback/ is never archived). */
export const scopeStillPath = (beat: string, what: ScopeStill['what']) => `feedback/scope/${beat}-${what}.jpg`

export const runManifestKey = (jobId: string, attemptId: string) => `${jobId}/runs/${attemptId}.json`

const refs = (r: BundleReference[] | undefined) =>
  // Only when there are some, so every other manifest keeps its bytes.
  r?.length
    ? { references: r.map((x) => ({ path: x.path, key: x.key, sha256: x.sha256, bytes: x.bytes })) }
    : {}

/** Field by field, in one order: a stored op comes back from jsonb with its keys in any order. */
const narrationOf = (n: FrozenNarration) => ({
  op: {
    op: n.op.op,
    schema: n.op.schema,
    sampleRate: n.op.sampleRate,
    clips: n.op.clips.map((c) => ({
      id: c.id,
      mediaId: c.mediaId,
      srcStart: c.srcStart,
      srcEnd: c.srcEnd,
      fit: { a: c.fit.a, b: c.fit.b, residualMs: c.fit.residualMs },
      offsetSamples: c.offsetSamples,
      start: c.start,
      gainDb: c.gainDb,
      fadeInSamples: c.fadeInSamples,
      fadeOutSamples: c.fadeOutSamples,
    })),
    tracks: {
      narration: {
        volumeDb: n.op.tracks.narration.volumeDb,
        muted: n.op.tracks.narration.muted,
        solo: n.op.tracks.narration.solo,
      },
      aiVoice: { mode: n.op.tracks.aiVoice.mode, volumeDb: n.op.tracks.aiVoice.volumeDb },
      music: { duck: n.op.tracks.music.duck, duckDb: n.op.tracks.music.duckDb },
      original: { muteAll: n.op.tracks.original.muteAll },
    },
    cleanup: n.op.cleanup,
  },
  takes: n.takes.map((t) => ({
    mediaId: t.mediaId,
    key: t.key,
    sha256: t.sha256,
    bytes: t.bytes,
    ...(t.license ? { license: t.license } : {}),
  })),
  recipe: { pipeline: n.recipe.pipeline, cleanup: n.recipe.cleanup },
  targetSamples: n.targetSamples,
  captions: n.captions,
  // Only when set, so a manifest frozen before it keeps its bytes.
  ...(n.transcriptionProvider ? { transcriptionProvider: n.transcriptionProvider } : {}),
  ...(n.language ? { language: n.language } : {}),
})

/** Stable bytes: the same inputs always serialize the same, so a re-sent start pins the same hash. */
export function serializeRunManifest(m: RunManifest): string {
  return JSON.stringify({
    v: m.v,
    jobId: m.jobId,
    attemptId: m.attemptId,
    versionN: m.versionN,
    kind: m.kind,
    source: m.source && {
      key: m.source.key,
      sha256: m.source.sha256,
      parentN: m.source.parentN,
      ...refs(m.source.references),
    },
    bundle: m.bundle && {
      key: m.bundle.key,
      sha256: m.bundle.sha256,
      manifestHash: m.bundle.manifestHash,
      // Only when there are lines to re-voice, so every other manifest keeps its bytes.
      ...(m.bundle.revoice
        ? { revoice: { beats: [...m.bundle.revoice.beats], keptHash: m.bundle.revoice.keptHash } }
        : {}),
      ...refs(m.bundle.references),
      ...(m.bundle.narration ? { narration: narrationOf(m.bundle.narration) } : {}),
      ...(m.bundle.recordingHolds?.length ? { recordingHolds: [...m.bundle.recordingHolds] } : {}),
    },
    media:
      m.media && m.media.map((x) => ({ key: x.key, sha256: x.sha256, filename: x.filename, kind: x.kind })),
    feedback: m.feedback && {
      video: { key: m.feedback.video.key, sha256: m.feedback.video.sha256 },
      pins: m.feedback.pins.map((p) => ({ commentId: p.commentId, timeSec: p.timeSec, x: p.x, y: p.y })),
    },
    // Only when set, so every HyperFrames manifest keeps its bytes.
    ...(m.engine
      ? {
          engine: {
            id: m.engine.id,
            ...(m.engine.tier ? { tier: m.engine.tier } : {}),
            ...(m.engine.development ? { development: true } : {}),
          },
        }
      : {}),
    // Only without the run secret (app/server/lib/run-auth.ts): the attempt's token, for prepare-run's .va-run/callback.json.
    ...(m.callback ? { callback: { token: m.callback.token } } : {}),
    // Only when scoped, so every other manifest keeps its bytes.
    ...(m.scope
      ? {
          scope: {
            beats: [...m.scope.beats],
            stills: m.scope.stills.map((x) => ({ atSec: x.atSec, path: x.path, what: x.what, beat: x.beat })),
          },
        }
      : {}),
    // Only with a look, so every other manifest keeps its bytes.
    ...(m.look ? { look: { id: m.look.id, key: m.look.key, sha256: m.look.sha256, hash: m.look.hash } } : {}),
    // Only for a demo, so every other manifest keeps its bytes.
    ...(m.recording
      ? {
          recording: {
            mediaId: m.recording.mediaId,
            key: m.recording.key,
            sha256: m.recording.sha256,
            filename: m.recording.filename,
            ...(m.recording.trace
              ? { trace: { key: m.recording.trace.key, sha256: m.recording.trace.sha256 } }
              : {}),
            boxes: m.recording.boxes,
            ...(m.recording.trim ? { trim: [m.recording.trim[0], m.recording.trim[1]] } : {}),
            ...(m.recording.compose ? { compose: true } : {}),
            ...(m.recording.privacy ? { privacy: true } : {}),
            ...(m.recording.hideStrings?.length ? { hideStrings: [...m.recording.hideStrings] } : {}),
          },
        }
      : {}),
  })
}

export const sha256Hex = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')

const HEX = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9_-]{1,80}$/
const MEDIA_ID = /^med_[a-z0-9]{8,40}$/
const HOLD_STILL = /^assets\/recording\/[a-z0-9-]{1,40}\.hold\.jpg$/

/** Parsed JSON: a frozen narration's shape, its takes' keys inside their own media prefix, and its caps. */
function isFrozenNarration(v: unknown): v is FrozenNarration {
  const rec = (x: unknown): Record<string, unknown> =>
    x && typeof x === 'object' ? (x as Record<string, unknown>) : {}
  const int = (x: unknown, lo: number, hi = Number.MAX_SAFE_INTEGER): x is number =>
    Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi
  const db = (x: unknown) => typeof x === 'number' && x >= GAIN_DB_RANGE[0] && x <= GAIN_DB_RANGE[1]
  const bool = (x: unknown) => typeof x === 'boolean'
  const n = rec(v)
  if (!Array.isArray(n.takes) || n.takes.length > MAX_NARRATION_TAKES) return false
  const ids = new Set<string>()
  let bytes = 0
  for (const x of n.takes as unknown[]) {
    const t = rec(x)
    const id = typeof t.mediaId === 'string' && MEDIA_ID.test(t.mediaId) ? t.mediaId : null
    if (
      !id ||
      ids.has(id) ||
      typeof t.key !== 'string' ||
      !new RegExp(`^${id}/(original|clean)\\.[a-z0-9]{2,5}$`).test(t.key) ||
      typeof t.sha256 !== 'string' ||
      !HEX.test(t.sha256) ||
      !int(t.bytes, 1) ||
      (t.license !== undefined && (typeof t.license !== 'string' || !/^[a-z0-9.-]{1,20}$/.test(t.license)))
    )
      return false
    ids.add(id)
    bytes += t.bytes
  }
  const recipe = rec(n.recipe)
  const op = rec(n.op)
  const tr = rec(op.tracks)
  const [voice, ai, music, original] = [rec(tr.narration), rec(tr.aiVoice), rec(tr.music), rec(tr.original)]
  const clipOk = (x: unknown) => {
    const c = rec(x)
    const fit = rec(c.fit)
    return (
      typeof c.id === 'string' &&
      c.id.length <= 80 &&
      typeof c.mediaId === 'string' &&
      ids.has(c.mediaId) &&
      int(c.srcStart, 0) &&
      int(c.srcEnd, c.srcStart + 1) &&
      int(c.start, 0, MAX_OUTPUT_SAMPLES) &&
      Number.isInteger(c.offsetSamples) &&
      [fit.a, fit.b, fit.residualMs].every(Number.isFinite) &&
      (c.gainDb === null || db(c.gainDb)) &&
      int(c.fadeInSamples, 0) &&
      int(c.fadeOutSamples, 0)
    )
  }
  return (
    bytes <= MAX_FROZEN_TAKE_BYTES &&
    int(n.targetSamples, 1, MAX_OUTPUT_SAMPLES) &&
    (n.captions === 'sidecar' || n.captions === 'burned') &&
    (n.transcriptionProvider === undefined ||
      ['local', 'elevenlabs', 'off'].includes(n.transcriptionProvider as string)) &&
    (n.language === undefined || isLanguage(n.language)) &&
    int(recipe.pipeline, 1, 1000) &&
    (NARRATION_CLEANUP_PRESETS as readonly unknown[]).includes(recipe.cleanup) &&
    op.op === 'narration' &&
    op.schema === 1 &&
    op.sampleRate === SAMPLE_RATE &&
    op.cleanup === recipe.cleanup &&
    Array.isArray(op.clips) &&
    op.clips.length <= MAX_NARRATION_CLIPS &&
    (op.clips as unknown[]).every(clipOk) &&
    db(voice.volumeDb) &&
    bool(voice.muted) &&
    bool(voice.solo) &&
    ['replace', 'under', 'keep'].includes(ai.mode as string) &&
    db(ai.volumeDb) &&
    bool(music.duck) &&
    db(music.duckDb) &&
    bool(original.muteAll)
  )
}

/** Parsed JSON: a scope's beats and stills, only on a revision; stills need the parent MP4 (feedback.video). */
function isScope(v: unknown, kind: RunKind, hasFeedback: boolean): v is RunScope {
  if (!v || typeof v !== 'object' || kind !== 'revision') return false
  const { beats, stills } = v as { beats?: unknown; stills?: unknown }
  if (
    !Array.isArray(beats) ||
    beats.length === 0 ||
    beats.length > MAX_SCOPE_BEATS ||
    !beats.every((b) => typeof b === 'string' && BEAT_ID.test(b)) ||
    new Set(beats).size !== beats.length
  )
    return false
  if (!Array.isArray(stills) || stills.length > MAX_SCOPE_STILLS || (stills.length > 0 && !hasFeedback))
    return false
  return stills.every((x: unknown) => {
    const s = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    return (
      typeof s.atSec === 'number' &&
      Number.isFinite(s.atSec) &&
      s.atSec >= 0 &&
      (s.what === 'before' || s.what === 'after') &&
      typeof s.beat === 'string' &&
      beats.includes(s.beat) &&
      typeof s.path === 'string' &&
      SCOPE_STILL.test(s.path)
    )
  })
}

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
  if (!RUN_KINDS.includes(m.kind)) throw new Error('Unknown run kind.')
  // Every key stays inside this video's own prefix.
  const own = (key: string) => key.startsWith(`${m.jobId}/`) && !key.includes('..') && !key.includes('//')
  if (m.source && (!own(m.source.key) || !HEX.test(m.source.sha256)))
    throw new Error('The run manifest has a bad source entry.')
  if (m.bundle && (!own(m.bundle.key) || !HEX.test(m.bundle.sha256) || !HEX.test(m.bundle.manifestHash)))
    throw new Error('The run manifest has a bad bundle entry.')
  // Reference files: known paths, each once, at the key finalize gives them in this video.
  for (const r of [m.source?.references, m.bundle?.references] as unknown[])
    if (
      r !== undefined &&
      (!Array.isArray(r) ||
        r.length === 0 ||
        !r.every((x) => isBundleReference(x, m.jobId)) ||
        new Set(r.map((x: BundleReference) => x.path)).size !== r.length)
    )
      throw new Error('The run manifest has a bad reference entry.')
  // Parsed JSON: check the shape rather than trust the type.
  const rv = m.bundle?.revoice as { beats?: unknown; keptHash?: unknown } | null | undefined
  if (
    rv !== undefined &&
    (rv === null ||
      typeof rv.keptHash !== 'string' ||
      !HEX.test(rv.keptHash) ||
      !Array.isArray(rv.beats) ||
      rv.beats.length === 0 ||
      rv.beats.length > 100 ||
      !rv.beats.every((b) => typeof b === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(b)))
  )
    throw new Error('The run manifest has a bad re-voice entry.')
  if (m.bundle?.narration !== undefined && !isFrozenNarration(m.bundle.narration))
    throw new Error('The run manifest has a bad narration entry.')
  if (m.bundle?.recordingHolds !== undefined) {
    const holds: unknown = m.bundle.recordingHolds
    if (
      m.kind !== 'render_unchanged' ||
      !Array.isArray(holds) ||
      holds.length > 12 ||
      !holds.every((p) => typeof p === 'string' && HOLD_STILL.test(p))
    )
      throw new Error('The run manifest has a bad recording holds entry.')
  }
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
  if (m.engine !== undefined) {
    // Parsed JSON: check the shape rather than trust the type.
    const raw: unknown = m.engine
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (!isEngineId(e.id)) throw new Error('The run manifest names an unknown engine.')
    if (e.tier !== undefined && (e.id !== 'remotion' || (e.tier !== 'free' && e.tier !== 'company')))
      throw new Error('The run manifest has a bad engine tier: only a Remotion run has one, free or company.')
    if (e.development !== undefined && (e.id !== 'remotion' || e.development !== true))
      throw new Error(
        'The run manifest has a bad engine development flag: only a Remotion run has one, true.',
      )
  }
  if (m.scope !== undefined && !isScope(m.scope, m.kind, m.feedback !== null))
    throw new Error('The run manifest has a bad scope entry.')
  if (m.look !== undefined) {
    // Parsed JSON: check the shape rather than trust the type.
    const raw: unknown = m.look
    const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (
      typeof l.id !== 'string' ||
      !LOOK_ID.test(l.id) ||
      typeof l.hash !== 'string' ||
      !HEX.test(l.hash) ||
      typeof l.sha256 !== 'string' ||
      !HEX.test(l.sha256) ||
      l.key !== `${m.jobId}/looks/${l.hash}.tar.gz`
    )
      throw new Error('The run manifest has a bad look entry.')
    // A render of the edited composition reads no look (§4.6).
    if (m.kind === 'render_unchanged') throw new Error('A render-unchanged run has no look.')
  }
  if (m.recording !== undefined && !isRecording(m.recording, m.media))
    throw new Error('The run manifest has a bad recording entry.')
  const cb = m.callback as { token?: unknown } | undefined
  if (cb !== undefined && (typeof cb.token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(cb.token)))
    throw new Error('The run manifest has a bad callback entry.')
  if (m.kind === 'revision' && !m.source) throw new Error('A revision run needs a source.')
  if (m.kind === 'render_unchanged' && !m.bundle) throw new Error('A render-unchanged run needs a bundle.')
  // A fit starts from the frozen draft alone, and exists for its narration (the guard and the bus target need it).
  if (m.kind === 'author_from_frozen' && (!m.bundle?.narration || m.source))
    throw new Error('A fit-to-narration run needs a frozen bundle with narration, and no source.')
  return m as RunManifest
}
