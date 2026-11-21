// A demo's recording across versions and runs (screen-recording plan §5.5): revisions and editor versions inherit the
// parent's inputs (the frozen trace, the person's boxes and trim), and every run of such a version gets them in its
// manifest, next to the recording's own library media entry.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import { classify, MediaError } from '../lib/media/classify.js'
import { round4, type BoxSpanOp } from '../lib/recording.js'
import {
  canonCrop,
  cropFromFractions,
  cropRedact,
  cropTrace,
  type RecordingCrop,
} from '../lib/recording-crop.js'
import { parseTrace } from '../lib/recording-trace.js'
import type { RunMedia, RunRecording } from '../lib/run-manifest.js'
import type { Principal } from './policy.js'
import { isScreenRecording } from './media-roles.js'
import type { Repo } from '../store/types.js'
import { canReadMedia } from './takes.js'
import { HIDE_STRINGS_MAX, normalizeHideString, PRIVACY_LABELS } from '../lib/privacy-patterns.js'
import type { HiddenArea, PrivacyNote, VersionMediaRow, VersionRecording } from './types.js'

/** The inputs a new version keeps from its parent's recording; the results (summary, hidden areas) are its run's. */
export function inheritRecording(parent: VersionRecording | null | undefined): VersionRecording | null {
  if (!parent) return null
  return {
    mediaId: parent.mediaId,
    trace: parent.trace,
    trim: parent.trim,
    boxes: parent.boxes,
    ...(parent.crop ? { crop: parent.crop } : {}),
    compose: parent.compose,
    ...(parent.privacy ? { privacy: true } : {}),
    ...(parent.hideStrings?.length ? { hideStrings: parent.hideStrings } : {}),
    summary: null,
    hidden: [],
  }
}

/**
 * The manifest's recording block: the version's recording and the media entry it downloads as. Null when the version
 * has no recording, or its media entry is missing (the run then has no recording to work from).
 */
export function manifestRecording(
  r: VersionRecording | null | undefined,
  media: RunMedia[] | null,
): RunRecording | null {
  if (!r) return null
  const item = media?.find((m) => m.kind === 'video' && m.key.startsWith(`${r.mediaId}/`))
  if (!item) return null
  return {
    mediaId: r.mediaId,
    key: item.key,
    sha256: item.sha256,
    filename: item.filename,
    ...(r.trace ? { trace: r.trace } : {}),
    boxes: r.boxes,
    ...(r.trim ? { trim: r.trim } : {}),
    ...(r.crop ? { crop: canonCrop(r.crop) } : {}),
    ...(r.compose ? { compose: true } : {}),
    ...(r.privacy ? { privacy: true } : {}),
    ...(r.hideStrings?.length ? { hideStrings: r.hideStrings } : {}),
  }
}

// ───── creating a demo (screen-recording plan §6.1; va-rsk5.3.16) ─────

/** A demo's target length when the request gives none: about 0.4 of the recording used, 20 to 90 seconds. */
export const demoDuration = (sourceSec: number) => Math.min(90, Math.max(20, Math.round(sourceSec * 0.4)))

export interface RecordingRequest {
  mediaId: string
  trim?: [number, number] | undefined
  /** [x, y, width, height] as fractions of the frame; the whole frame when left out. */
  crop?: [number, number, number, number] | undefined
  redact?:
    | {
        /** The whole recording when left out (0 to its end). */
        start?: number | undefined
        end?: number | undefined
        box: [number, number, number, number]
        style?: 'blur' | 'solid' | undefined
      }[]
    | undefined
  /** Privacy mode (off by default). */
  privacy?: boolean | undefined
  hideStrings?: string[] | undefined
}

/**
 * The checks that read bytes, before the transaction: an ordinary clip (not uploaded as a screen recording) is usable
 * when it already meets the recording rules (§4.2), else 400 with what to run.
 */
export async function checkRecordingBytes(deps: Pick<Deps, 'store' | 'blobs'>, req: RecordingRequest) {
  const m = await deps.store.getMedia(req.mediaId)
  if (!m || m.kind !== 'video' || isScreenRecording(m)) return
  const bytes = await deps.blobs.get('media', m.originalKey)
  if (!bytes) return
  try {
    const c = classify(bytes, { role: 'screen-recording' })
    if (c.kind !== 'video') throw new MediaError("It isn't a video.")
  } catch (e) {
    if (e instanceof MediaError)
      throw new ApiError('invalid_request', `This clip can't be used as a recording: ${e.message}`)
    throw e
  }
}

/**
 * The recording a new demo is made from, inside the create transaction: a ready video the caller can read, not being
 * deleted, a trim inside it, boxes inside the frame. Returns the version's recording, its media row and whether the
 * video starts private (anything hidden: setup boxes, redact entries in its trace, or privacy mode, which hides more).
 */
export async function demoRecording(
  repo: Repo,
  deps: Pick<Deps, 'blobs'>,
  p: Principal,
  req: RecordingRequest,
  jobId: string,
  n: number,
) {
  const m = await repo.getMedia(req.mediaId)
  if (!m || m.deletedAt || !(await canReadMedia(repo, p, m)))
    throw new ApiError('not_found', 'Media not found.')
  if (m.deletingAt) throw new ApiError('gone', 'This recording is being deleted; upload it again.')
  if (m.kind !== 'video' || m.status !== 'ready')
    throw new ApiError('invalid_request', `Media ${m.id} isn't a ready video, so it can't be a recording.`)
  const length = m.durationSec ?? 0
  const [tin, tout] = req.trim ?? [0, length]
  if (req.trim && !(tin >= 0 && tout > tin && tout <= length + 0.5 && tout - tin >= 2))
    throw new ApiError(
      'invalid_request',
      `trim must be [in, out] inside the recording (0 to ${String(Math.round(length * 10) / 10)} s), at least 2 seconds.`,
    )
  let crop: RecordingCrop | null = null
  if (req.crop) {
    if (!m.width || !m.height)
      throw new ApiError('invalid_request', `Media ${m.id} has no known size, so it can't be cropped.`)
    try {
      crop = cropFromFractions(req.crop, m.width, m.height)
    } catch (e) {
      throw new ApiError('invalid_request', e instanceof Error ? e.message : 'crop is not valid.')
    }
  }
  const drawn = (req.redact ?? []).map((r0, i) => {
    // A box covers the whole recording unless it says otherwise (the editor can shorten it later).
    const r = { ...r0, start: r0.start ?? 0, end: r0.end ?? length }
    const [x, y, w, h] = r.box
    if (!(r.end > r.start) || x + w > 1 + 1e-9 || y + h > 1 + 1e-9 || !(w > 0 && h > 0))
      throw new ApiError(
        'invalid_request',
        `Hidden area ${String(i + 1)} must be inside the frame, start before end.`,
      )
    return {
      start: r.start,
      end: Math.min(r.end, length || r.end),
      reason: 'Hidden by you',
      ...(r.style === 'solid' ? { style: 'solid' as const } : {}),
      boxes: [[r.start, x, y, w, h]] as [number, number, number, number, number][],
    }
  })
  // With a crop the cropped picture is the frame: boxes are kept as fractions of it, and one outside it has nothing
  // to hide.
  const boxes = cropRedact(drawn, crop)
  const trace = m.traceKey && m.traceSha256 ? { key: m.traceKey, sha256: m.traceSha256 } : null
  let traceHides = 0
  if (trace) {
    const bytes = await deps.blobs.get('media', trace.key)
    traceHides = bytes ? cropTrace(parseTrace(new TextDecoder().decode(bytes)), crop).redact.length : 0
  }
  // Trimmed, inner whitespace collapsed, empty and repeated ones dropped.
  const hideStrings = [
    ...new Set((req.hideStrings ?? []).map(normalizeHideString).filter((x) => x.length >= 2)),
  ].slice(0, HIDE_STRINGS_MAX)
  const recording: VersionRecording = {
    mediaId: m.id,
    trace,
    trim: req.trim ? [tin, tout] : null,
    boxes,
    ...(crop ? { crop } : {}),
    compose: false,
    ...(req.privacy ? { privacy: true } : {}),
    ...(hideStrings.length ? { hideStrings } : {}),
    summary: null,
    hidden: [],
  }
  const row: VersionMediaRow = {
    jobId,
    versionN: n,
    mediaId: m.id,
    position: 0,
    kind: 'video',
    key: m.cleanKey,
    sha256: m.cleanSha256,
    filename: `${m.id}.${m.ext}`,
    caption: null,
  }
  return {
    recording,
    row,
    private: drawn.length > 0 || traceHides > 0 || req.privacy === true || hideStrings.length > 0,
    sourceSec: tout - tin,
  }
}

/**
 * Why an area is hidden, for the Hidden list: drawn by the person (setup or the editor), marked when recorded (a
 * password field, a --hide selector), or found in privacy mode ("Privacy mode: email").
 */
export function hiddenWhy(h: Pick<HiddenArea, 'source' | 'reason'>): string {
  const reason = h.reason.trim()
  switch (h.source) {
    case 'setup':
      return 'You drew it'
    case 'editor':
      return 'You drew it in the editor'
    case 'trace':
      // video-agent record: a password field, a --hide selector, --hide-text, or --privacy's "Privacy mode: email".
      return reason === 'password field'
        ? 'Password field'
        : reason === 'hidden text'
          ? 'Text you asked to hide'
          : /^privacy mode/i.test(reason)
            ? reason
            : 'Marked hidden when recorded'
    case 'agent':
      return /^privacy mode/i.test(reason) ? reason : `Added by the agent${reason ? `: ${reason}` : ''}`
  }
}

/** A version's recording with the editor's span changes to the person's setup boxes (box i is redact.js' s<i+1>). */
export function withBoxSpans<R extends VersionRecording | null>(r: R, ops: BoxSpanOp[]): R {
  if (!r || !ops.length) return r
  const boxes = r.boxes.map((b, i) => {
    const o = ops.findLast((x) => x.id === `s${String(i + 1)}`)
    return o ? { ...b, start: round4(o.start), end: round4(o.end) } : b
  })
  return { ...r, boxes }
}

const NOTE_KINDS = new Set<string>(['email', 'key', 'token', 'url', 'card', 'phone'])

/**
 * The output check's private-looking matches from the run's manifest (render-job), as the version keeps them: known
 * kinds at real times, one per kind a second, at most 50. Anything else in the manifest is dropped.
 */
export function privacyNotesOf(check: unknown, durationSec: number): PrivacyNote[] {
  const noted = (check as { noted?: unknown } | null)?.noted
  if (!Array.isArray(noted)) return []
  const seen = new Set<string>()
  const out: PrivacyNote[] = []
  for (const n of noted as { t?: unknown; kind?: unknown }[]) {
    const t = typeof n.t === 'number' && Number.isFinite(n.t) ? n.t : -1
    if (t < 0 || t > durationSec + 1 || typeof n.kind !== 'string' || !NOTE_KINDS.has(n.kind)) continue
    const key = `${n.kind}@${String(Math.floor(t))}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ t: Math.round(t * 100) / 100, kind: n.kind as PrivacyNote['kind'] })
    if (out.length === 50) break
  }
  return out.sort((a, b) => a.t - b.t)
}

/** A privacy note for people: "An email may still be readable at 0:12". */
export function privacyWarningOf(n: PrivacyNote): string {
  const at = `${String(Math.floor(n.t / 60))}:${String(Math.floor(n.t % 60)).padStart(2, '0')}`
  const what = PRIVACY_LABELS[n.kind]
  // "An email", but "A URL" and "A key": only email starts with a vowel sound.
  return `${n.kind === 'email' ? 'An' : 'A'} ${what} may still be readable at ${at}`
}
