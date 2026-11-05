// Edit drafts (plan v2 §8): each person edits their own draft of a finished contract-1 version. Every save sends the
// whole list of operations; the server re-applies them to the version's bundle with the same patcher the browser
// uses and stores an immutable bundle for that rev, which the preview plays and a render freezes.
import type { Deps } from '../deps.js'
import { excluded, manifestHash } from '../lib/bundle-manifest.js'
import { isReference } from '../lib/bundle-references.js'
import {
  applyEdits,
  applyNarration,
  ContractError,
  FPS,
  load,
  read as readComposition,
  type EditOp,
  type Summary,
} from '../lib/contract.js'
import type { Language } from '../lib/language.js'
import { NARRATION_PIPELINE } from '../lib/narration-cleanup.js'
import { wholeClipSpans } from '../lib/peaks.js'
import { MAX_FROZEN_TAKE_BYTES, type CaptionPolicy, type FrozenNarration } from '../lib/run-manifest.js'
import {
  clipEnd,
  fitTarget,
  holdFrameEnd,
  MAX_NARRATION_TAKES,
  opTakeIds,
  outputEnd,
  outputLimit,
  resolve,
  SAMPLE_RATE,
  samplesToSeconds,
  secondsToSamples,
  withinOutputLimit,
  withoutAlternatives,
  type NarrationOp,
  type Span,
} from '../lib/timeline.js'
import { keptHash } from '../lib/revoice.js'
import { parseScript, VOICE_JSON, VOICE_SCRIPT, type VoiceFile, type VoiceScript } from '../lib/voice.js'
import { signPath, sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { writeTarGz } from '../lib/tar.js'
import { PREVIEW_TTL_SEC, previewScope } from '../lib/preview.js'
import { contextMeta } from '../generated/context.js'
import {
  bundleFileKey,
  bundlePrefix,
  contractForEngine,
  ensureBundle,
  type BundleEntry,
  type BundleIndex,
} from './bundles.js'
import { assertCan, type Principal } from './policy.js'
import { assertSameEngine, engineOf } from './engines.js'
import { snapshotMedia } from './media.js'
import { addAttemptRefs, canReadTake, isTake, releaseOwnerRefs, replaceDraftRefs } from './takes.js'
import { getSettings } from './settings.js'
import { narrationEnabled, narrationSettings } from './narration-settings.js'
import { assertNarrationLock } from './narration-lock.js'
import { canonical, narrationChangedSince } from './narration-stale.js'
import type { Repo } from '../store/types.js'
import { type EditRow, type MediaRow, type TranscriptionProvider, type VersionRow } from './types.js'
import { hasUnfinished, loadJob, newAttempt, videoDto, withIdempotency } from './videos.js'

export const EDIT_TTL_MS = 7 * 24 * 3600_000
const MAX_OPS = 500
const AUDIO_FILE = /\.(mp3|m4a|aac|wav|ogg|opus|webm)$/i

/** A draft's ops: the contract's edits, plus at most one whole-track narration op (plan 2026-11-02 §6.1). */
export type DraftOp = EditOp | NarrationOp

export const editPrefix = (jobId: string, n: number, editId: string) =>
  `${bundlePrefix(jobId, n)}e/${editId}/`
export const editRevPrefix = (jobId: string, n: number, editId: string, rev: number) =>
  `${editPrefix(jobId, n, editId)}r${rev}/`
/** What a draft preview capability signs: one draft, never the version or other drafts. */
export const editScope = (jobId: string, n: number, editId: string) => `${previewScope(jobId, n)}/e/${editId}`

/** The base version's preview bundle. */
async function baseIndex(deps: Deps, jobId: string, n: number) {
  const index = await ensureBundle(deps, jobId, n)
  if (!index) throw new ApiError('not_found', "This version's composition isn't available.")
  return index
}

async function readEntry(deps: Deps, f: BundleEntry) {
  const b = f.src ? await deps.blobs.get(f.src.store, f.src.key) : null
  if (!b) throw new ApiError('conflict', "This version's composition is incomplete. Try again later.")
  return b
}

const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : '')
/** voice.json as voice.ts writes it, or null. */
function parseVoice(raw: string): VoiceFile | null {
  try {
    const v = JSON.parse(raw || 'null') as Partial<VoiceFile> | null
    return v?.v === 1 && Array.isArray(v.beats) ? (v as VoiceFile) : null
  } catch {
    return null
  }
}
function parseVoiceScript(raw: string): VoiceScript | null {
  try {
    return parseScript(raw)
  } catch {
    return null
  }
}

// ───── recorded narration (plan 2026-11-02 §6.1) ─────
const secs = (samples: number) => `${String(Math.round(samplesToSeconds(samples) * 10) / 10)}s`

/** The draft's narration op, or null; the track is one snapshot, so a second one is refused. */
function narrationOp(ops: DraftOp[]): NarrationOp | null {
  const found = ops.filter((o): o is NarrationOp => o.op === 'narration')
  if (found.length > 1)
    throw new ApiError('invalid_request', 'A draft has one narration track: send one narration op.')
  return found[0] ?? null
}

/**
 * The takes an op uses, at most 32 (in first-use order): the clips' own and their alternatives (plan 2026-11-02 §9
 * phase 6), which the draft holds like any other take until a render freezes only the selected ones.
 */
function takeIds(op: NarrationOp) {
  const ids = opTakeIds(op.clips)
  if (ids.length > MAX_NARRATION_TAKES)
    throw new ApiError('invalid_request', `A narration uses at most ${MAX_NARRATION_TAKES} recordings.`)
  return ids
}

// Read before a transaction (it queries the settings row directly, uncached, so an admin's switch applies at once).
const narrationOff = () =>
  new ApiError('narration_disabled', 'Recorded voice-over is turned off on this site.')

/**
 * Who may place a take (plan 2026-11-02 §6.1, §8). A new pick is a ready, undeleted audio item the saver can read
 * (canReadTake). A take the base version's narration already plays is inherited: the version holds it (media_refs),
 * so it stays usable through its uploader's soft delete or a change of hands. Anything else reads as unavailable,
 * never forbidden, so a take's existence doesn't leak.
 */
async function checkTakeAccess(
  repo: Repo,
  p: Principal,
  e: Pick<EditRow, 'jobId' | 'baseN'>,
  op: NarrationOp,
) {
  const ids = takeIds(op)
  const inherited = new Set(
    (await repo.listMediaRefsByOwner('version', `${e.jobId}#${e.baseN}`)).map((r) => r.mediaId),
  )
  for (const id of ids) {
    const m = await repo.getMedia(id)
    const ok =
      m?.kind === 'audio' &&
      !m.deletingAt &&
      (inherited.has(id) || (m.status === 'ready' && !m.deletedAt && (await canReadTake(repo, p, m))))
    if (!ok)
      throw new ApiError('invalid_request', `That edit can't be made: recording ${id} isn't available.`, {
        mediaId: id,
      })
  }
}

const isSpan = (x: unknown): x is Span =>
  Array.isArray(x) && x.length === 2 && x.every(Number.isInteger) && (x[1] as number) > (x[0] as number)

/**
 * A take's length and speech spans in source samples. meta.json carries them once upload sessions store the summary
 * (va-2qq.2.6: `samples`, `speech`); until then the row's duration, and speech throughout (wholeClipSpans).
 */
export async function takeSummary(
  deps: Deps,
  m: MediaRow,
): Promise<{ samples: number | null; speech: Span[] }> {
  let meta: { samples?: unknown; speech?: unknown } = {}
  try {
    meta = JSON.parse(
      text((await deps.blobs.get('media', `${m.id}/meta.json`)) ?? undefined) || '{}',
    ) as typeof meta
  } catch {
    // An unreadable summary is the same as none.
  }
  const samples =
    Number.isInteger(meta.samples) && (meta.samples as number) > 0
      ? (meta.samples as number)
      : m.durationSec
        ? secondsToSamples(m.durationSec)
        : null
  const speech =
    Array.isArray(meta.speech) && meta.speech.every(isSpan) ? meta.speech : wholeClipSpans(samples ?? 0)
  return { samples, speech }
}

/**
 * Checks a narration op against its takes and the visuals it plays over (`baseSamples`): at most 32 takes, every clip
 * inside its take, resolved clips apart, and the end within the output limit (the video + 120 s, 15 min in all).
 * Takes and the base never change, so every recompute checks this; who may use a take is checkTakeAccess's job, on
 * save and render. Returns each take's speech spans for the draft's data-va-speech.
 */
async function narrationTakes(deps: Deps, repo: Repo, op: NarrationOp, baseSamples: number) {
  const speech = new Map<string, Span[]>()
  for (const id of takeIds(op)) {
    const m = await repo.getMedia(id)
    if (!m || m.deletingAt)
      throw new ApiError('take_deleted', 'A recording this uses was deleted. Record or pick another take.', {
        mediaIds: [id],
      })
    const t = await takeSummary(deps, m)
    if (t.samples === null)
      throw new ApiError('invalid_request', `Recording ${id} can't be placed yet: its length isn't known.`)
    const past = (x: { mediaId: string; srcEnd: number }) => x.mediaId === id && x.srcEnd > (t.samples ?? 0)
    const over = op.clips.find(past)
    if (over)
      throw new ApiError(
        'invalid_request',
        `That edit can't be made: clip ${over.id} runs past the end of its recording.`,
      )
    const alt = op.clips.find((c) => c.alternatives?.some(past))
    if (alt)
      throw new ApiError(
        'invalid_request',
        `That edit can't be made: a take of clip ${alt.id} runs past the end of its recording.`,
      )
    speech.set(id, t.speech)
  }
  const r = resolve(op.clips)
  if (r.some((c, i) => i > 0 && c.start < clipEnd(r[i - 1] as typeof c)))
    throw new ApiError('invalid_request', "That edit can't be made: the narration's clips overlap.")
  const end = outputEnd(r)
  if (!withinOutputLimit(end, baseSamples))
    throw new ApiError(
      'invalid_request',
      `The narration runs to ${secs(end)}; this video's can run to ${secs(outputLimit(baseSamples))} at most.`,
    )
  return speech
}

/** Colours a role may take: the ones the composition already uses, plus the brand's primary colour. */
export function paletteOf(colors: Record<string, string>) {
  return [...new Set([...Object.values(colors), contextMeta.primaryColor].map((c) => c.trim().toLowerCase()))]
}

/**
 * Applies the ops to the base (in memory). Throws ApiError (400, with the contract violations) when an edit would
 * break the composition. Inside a transaction, `repo` is its handle.
 */
async function computeRev(
  deps: Deps,
  e: Pick<EditRow, 'jobId' | 'baseN'>,
  draftOps: DraftOp[],
  repo: Repo = deps.store,
  opts: { holdFinalFrame?: boolean } = {},
) {
  // The narration goes on last, over the edited visuals, so its spans and the music's dip follow every retime.
  const track = narrationOp(draftOps)
  const ops = draftOps.filter((o): o is EditOp => o.op !== 'narration')
  const index = await baseIndex(deps, e.jobId, e.baseN)
  // Unchanged files are served from where they already are; only index.html and summary.json are rewritten.
  const entries = new Map<string, BundleEntry>(
    index.files.map((f) => [
      f.path,
      { ...f, src: f.src ?? { store: 'bundles', key: bundleFileKey(e.jobId, e.baseN, f.path) } },
    ]),
  )
  const read = async (path: string) => {
    const f = entries.get(path)
    return f ? text(await readEntry(deps, f)) : ''
  }
  const html = await read('index.html')
  const summary = JSON.parse((await read('summary.json')) || '{}') as Summary
  // Each voiced beat's line as it was spoken, which voice ops change and the editor shows.
  const voice = parseVoice(await read(VOICE_JSON))
  const narration = voice?.beats.length
    ? Object.fromEntries(voice.beats.map((b) => [b.beat, b.text]))
    : undefined
  let base
  try {
    base = applyEdits(html, summary, [], { ...(narration ? { narration } : {}) })
  } catch (err) {
    // A version made before a contract rule tightened can fail it: say so instead of failing the request.
    if (err instanceof ContractError)
      throw new ApiError(
        'conflict',
        `This version can't be edited in the browser (${err.violations[0] ?? 'it no longer passes the editing check'}). Ask for a revision instead.`,
        { violations: err.violations },
      )
    throw err
  }
  const palette = paletteOf(base.composition.colors)
  const baseComposition = base.composition
  let out
  try {
    out = applyEdits(html, summary, ops, { palette, ...(narration ? { narration } : {}) })
  } catch (err) {
    if (err instanceof ContractError)
      throw new ApiError('invalid_request', `That edit can't be made: ${err.violations.join(' ')}`, {
        violations: err.violations,
      })
    throw err
  }
  let outHtml = out.html
  let composition = out.composition
  // The visuals' length, and the narration bus's: longer only for a render that holds the last frame.
  const visualSamples = secondsToSamples(out.composition.duration)
  let targetSamples = visualSamples
  if (track) {
    const speech = await narrationTakes(deps, repo, track, visualSamples)
    if (opts.holdFinalFrame) targetSamples = holdTarget(track, visualSamples)
    try {
      outHtml = applyNarration(out.html, out.summary, track, speech, {
        holdSeconds: samplesToSeconds(targetSamples - visualSamples),
      }).html
    } catch (err) {
      if (err instanceof ContractError)
        throw new ApiError('invalid_request', `That edit can't be made: ${err.violations.join(' ')}`, {
          violations: err.violations,
        })
      throw err
    }
    composition = readComposition(load(outHtml), out.narration)
  }
  const changed = new Map<string, Uint8Array>([
    ['index.html', new TextEncoder().encode(outHtml)],
    ['summary.json', new TextEncoder().encode(JSON.stringify(out.summary, null, 2))],
  ])
  // Changed lines go into the voice script, where the render run's scripts/voice.ts revoice reads them.
  const revoiced = composition.narration.filter((n) => n.revoice)
  if (voice && revoiced.length) {
    const was = parseVoiceScript(await read(VOICE_SCRIPT))
    const lines = was
      ? was.lines.map((l) => ({ ...l }))
      : voice.beats.map((b) => ({ beat: b.beat, text: b.text }))
    for (const n of revoiced) {
      const line = lines.find((l) => l.beat === n.beat)
      if (line) line.text = n.text
      else lines.push({ beat: n.beat, text: n.text })
    }
    const script: VoiceScript = was ? { ...was, lines } : { voice: voice.voice, speed: voice.speed, lines }
    changed.set(VOICE_SCRIPT, new TextEncoder().encode(JSON.stringify(script, null, 2)))
  }
  for (const [path, bytes] of changed)
    entries.set(path, { path, size: bytes.byteLength, sha256: sha256Hex(bytes) })
  // Media and music swapped in from the library (plan v2 §8): ready items only, of the slot's (or audio's) kind,
  // served from the library.
  const picks: string[] = []
  for (const op of ops) {
    if ((op.op !== 'media' && op.op !== 'audio') || !op.src) continue
    const src = op.src
    const kind = op.op === 'media' ? op.kind : 'audio'
    if (entries.has(src)) {
      // A file the composition already has; an audio track only takes another sound file.
      if (kind === 'audio' && !AUDIO_FILE.test(src))
        throw new ApiError('invalid_request', `That edit can't be made: ${src} isn't an audio file.`)
      continue
    }
    const file = src.slice('assets/media/'.length)
    const m = await repo.getMedia(file.split('.')[0] ?? '')
    const fits = kind === 'image' ? m?.kind === 'image' || m?.kind === 'svg' : m?.kind === kind
    // A narration take isn't a library item: it's placed with the narration op, never as a media or audio pick.
    // Takes go in through narration, not as a library pick into a slot.
    if (!m || m.deletedAt || m.status !== 'ready' || isTake(m) || `${m.id}.${m.ext}` !== file || !fits)
      throw new ApiError(
        'invalid_request',
        `That edit can't be made: ${file} isn't a ready ${kind} in the library.`,
      )
    entries.set(src, {
      path: src,
      size: m.bytes,
      sha256: m.cleanSha256,
      src: { store: 'media', key: m.cleanKey },
    })
    picks.push(m.id)
  }
  const list = [...entries.values()]
  return {
    changed,
    list,
    picks,
    track,
    composition,
    targetSamples,
    base: baseComposition,
    palette,
    bundleSha256: manifestHash(
      list.map(({ path, sha256 }) => ({ path, sha256 })),
      [],
    ),
  }
}
type Rev = Awaited<ReturnType<typeof computeRev>>

/** Computes the rev and writes its immutable bundle (the newest rev only is kept). */
async function buildRev(
  deps: Deps,
  e: Pick<EditRow, 'id' | 'jobId' | 'baseN'>,
  rev: number,
  ops: DraftOp[],
  repo: Repo = deps.store,
) {
  const r = await computeRev(deps, e, ops, repo)
  const { changed, list } = r
  const prefix = editRevPrefix(e.jobId, e.baseN, e.id, rev)
  for (const [path, bytes] of changed) await deps.blobs.set('bundles', `${prefix}f/${path}`, bytes)
  const engine = (await repo.getVersion(e.jobId, e.baseN))?.engine
  const index: BundleIndex = {
    v: 1,
    jobId: e.jobId,
    versionN: e.baseN,
    files: list,
    createdAt: deps.clock.now().toISOString(),
    contract: contractForEngine(engine, changed),
  }
  await deps.blobs.set('bundles', `${prefix}manifest.json`, JSON.stringify(index), {
    contentType: 'application/json',
  })
  // Only the newest rev is kept.
  for (const k of await deps.blobs.list('bundles', editPrefix(e.jobId, e.baseN, e.id)))
    if (!k.startsWith(prefix)) await deps.blobs.delete('bundles', k)
  return r
}

async function editDto(deps: Deps, e: EditRow, built?: Rev, repo: Repo = deps.store) {
  const job = await repo.getJob(e.jobId)
  // Reads recompute in memory; only saves write bundles.
  const b = built ?? (await computeRev(deps, e, e.ops as DraftOp[]))
  return {
    id: e.id,
    videoId: e.jobId,
    baseN: e.baseN,
    rev: e.rev,
    ops: e.ops as DraftOp[],
    composition: b.composition,
    // The version as it was: the editor diffs against it to build the op list.
    base: b.base,
    palette: b.palette,
    expiresAt: e.expiresAt,
    renderedN: e.renderedN,
    // Someone else rendered (or revised) since this draft started: "start from vN, or render yours as vN+1".
    newerVersion: job && job.latestVersion > e.baseN ? job.latestVersion : null,
    // A newer version changed the narration since this draft's base: Rebase onto it, or Keep mine.
    narrationChanged: await narrationChangedSince(repo, e),
  }
}

/** The caller's draft of a version: the open one if there is one, else a new, empty one. */
export async function openEdit(deps: Deps, p: Principal, jobId: string, n: number) {
  await loadJob(deps.store, p, jobId)
  assertCan(p, 'edit:create')
  const v = await deps.store.getVersion(jobId, n)
  if (!v) throw new ApiError('not_found', 'Version not found.')
  if (v.status !== 'ready' || v.contract !== 1)
    throw new ApiError('conflict', "This version can't be edited in the browser. Ask for a revision instead.")
  const now = deps.clock.now()
  const existing = await deps.store.findEdit(p.userId, jobId, n, now.toISOString())
  if (existing) return { created: false, edit: await editDto(deps, existing) }
  const row: EditRow = {
    id: deps.ids.uuid(),
    jobId,
    baseN: n,
    authorId: p.userId,
    rev: 0,
    ops: [],
    bundleSha256: null,
    renderedN: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EDIT_TTL_MS).toISOString(),
  }
  const built = await buildRev(deps, row, 0, [])
  row.bundleSha256 = built.bundleSha256
  await deps.store.insertEdit(row)
  return { created: true, edit: await editDto(deps, row, built) }
}

/** Only the author sees a draft; to anyone else it doesn't exist. */
async function loadEdit(repo: Repo, deps: Pick<Deps, 'clock'>, p: Principal, id: string, lock = false) {
  const e = await repo.getEdit(id, { lock })
  if (!e || e.authorId !== p.userId || e.expiresAt < deps.clock.now().toISOString())
    throw new ApiError('not_found', 'Draft not found.')
  await loadJob(repo, p, e.jobId)
  return e
}

export async function getEdit(deps: Deps, p: Principal, id: string) {
  return editDto(deps, await loadEdit(deps.store, deps, p, id))
}

/** Saves the full op list as the next rev. `rev` must be the one the editor started from (multi-tab safety). */
export async function saveEdit(deps: Deps, p: Principal, id: string, input: { ops: DraftOp[]; rev: number }) {
  assertCan(p, 'edit:create')
  if (input.ops.length > MAX_OPS) throw new ApiError('invalid_request', `At most ${MAX_OPS} edits per draft.`)
  const track = narrationOp(input.ops)
  if (track && !(await narrationEnabled(deps))) throw narrationOff()
  return deps.store.tx(async (repo) => {
    const e = await loadEdit(repo, deps, p, id, true)
    if (e.renderedN !== null)
      throw new ApiError('conflict', `This draft was already rendered as v${e.renderedN}.`)
    if (input.rev !== e.rev)
      throw new ApiError('conflict', 'This draft changed in another tab. Reload it to continue.', {
        rev: e.rev,
      })
    if (track) {
      // The narration soft lock (plan 2026-11-02 §2.7) covers narration only: a save that changes the track needs it;
      // one that carries it unchanged (other edits, an autosave) doesn't.
      if (canonical(track) !== canonical(narrationOp(e.ops as DraftOp[])))
        await assertNarrationLock(deps, repo, p, e)
      await checkTakeAccess(repo, p, e, track)
    }
    // The draft holds exactly the takes its narration places (none without one), locked before the rev is built.
    await replaceDraftRefs(repo, deps, e.id, e.jobId, track ? takeIds(track) : [])
    const rev = e.rev + 1
    const built = await buildRev(deps, e, rev, input.ops, repo)
    const now = deps.clock.now()
    const next: EditRow = {
      ...e,
      rev,
      ops: input.ops,
      bundleSha256: built.bundleSha256,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + EDIT_TTL_MS).toISOString(),
    }
    await repo.updateEdit(id, next)
    return editDto(deps, next, built, repo)
  })
}

/** Discarding releases the draft's narration takes (they're kept for 30 days), never deletes them. */
export async function discardEdit(deps: Deps, p: Principal, id: string) {
  const e = await loadEdit(deps.store, deps, p, id)
  for (const k of await deps.blobs.list('bundles', editPrefix(e.jobId, e.baseN, e.id)))
    await deps.blobs.delete('bundles', k)
  await dropEdit(deps, id)
}

/** The draft row and its take references go together. */
const dropEdit = (deps: Deps, id: string) =>
  deps.store.tx(async (repo) => {
    await releaseOwnerRefs(repo, deps, 'draft', id)
    await repo.deleteEdit(id)
  })

/** A preview capability for the draft's current rev. */
export async function editPreviewLink(deps: Deps, p: Principal, id: string) {
  const e = await loadEdit(deps.store, deps, p, id)
  const job = await loadJob(deps.store, p, e.jobId)
  const { fileSigningSecret } = await getSettings(deps)
  const exp = Math.floor(deps.clock.now().getTime() / 1000) + PREVIEW_TTL_SEC
  const epoch = job.private ? job.accessEpoch : undefined
  const sig = signPath(fileSigningSecret, editScope(e.jobId, e.baseN, e.id), exp, epoch)
  return {
    url: `${deps.config.siteUrl}${previewScope(e.jobId, e.baseN)}/${exp}.${epoch ?? 'x'}.${sig}/e/${e.id}/r${e.rev}/index.html`,
    expiresAt: new Date(exp * 1000).toISOString(),
    seq: e.rev,
  }
}

/** Sweep: expired drafts go, with their bundles; their narration takes are released (and kept for 30 days). */
export async function deleteExpiredEdits(deps: Deps, limit = 20) {
  for (const e of await deps.store.listExpiredEdits(deps.clock.now().toISOString(), limit)) {
    for (const k of await deps.blobs.list('bundles', editPrefix(e.jobId, e.baseN, e.id)))
      await deps.blobs.delete('bundles', k)
    await dropEdit(deps, e.id)
  }
}

export type RenderMode = 'keep_visuals' | 'fit_to_narration'
export interface RenderSettings {
  mode: RenderMode
  /** Narration past the end holds the last frame (plus a 0.5 s post-roll) instead of being cut off. */
  holdFinalFrame: boolean
  captions: CaptionPolicy
  /**
   * Render picture first (plan 2026-11-02 §2.1, §5.3): the draft's other ops only, frozen without its narration op,
   * so the person records against the new picture. The op stays in the draft, and rebaseNarration moves it onto the
   * version this makes.
   */
  excludeNarration: boolean
}

/**
 * The narration bus's length when a render holds the last frame (plan 2026-11-02 §2.5, §6.1): with an overrun, the
 * audible narration's end plus the 0.5 s post-roll in whole frames, so the held-frame beat is the difference;
 * otherwise the visuals' length. Refused past the output limit (base + 120 s, never over 15 min).
 */
function holdTarget(op: NarrationOp, baseSamples: number) {
  const target = holdFrameEnd(op.clips, baseSamples, FPS)
  if (!withinOutputLimit(target, baseSamples))
    throw new ApiError(
      'invalid_request',
      `Holding the last frame would make the video ${secs(target)}; it can run to ${secs(outputLimit(baseSamples))} at most. Trim the narration instead.`,
    )
  return target
}

/**
 * The bus length a fit freezes (plan 2026-11-02 §6.4): the audible narration's end plus the 0.5 s post-roll in whole
 * frames (timeline.fitTarget), which the agent's beats must total exactly. Refused when nothing is heard, or past the
 * output limit of the visuals it starts from (base + 120 s, never over 15 min).
 */
function fitTargetOf(op: NarrationOp, baseSamples: number) {
  const target = fitTarget(op.clips, FPS)
  if (!(target > 0))
    throw new ApiError(
      'invalid_request',
      "None of the narration is audible, so there's nothing to fit the video to. Unmute a clip first.",
    )
  if (!withinOutputLimit(target, baseSamples))
    throw new ApiError(
      'invalid_request',
      `Fitting the video to the narration would make it ${secs(target)}; it can run to ${secs(outputLimit(baseSamples))} at most. Trim the narration instead.`,
    )
  return target
}

/** Fit always replaces the AI voice-over (plan 2026-11-02 §12 decision 11): Keep and Under are for keep-visuals only. */
const replacingAiVoice = (o: DraftOp): DraftOp =>
  o.op === 'narration' && o.tracks.aiVoice.mode !== 'replace'
    ? { ...o, tracks: { ...o.tracks, aiVoice: { ...o.tracks.aiVoice, mode: 'replace' } } }
    : o

/**
 * frozen.narration for a render (plan 2026-11-02 §6.1, §6.3, §6.4). The op keeps only what's audible (resolved clips
 * with a level that start inside the target), and the takes are only the ones those play: by key and digest from the
 * media store, never snapshotted with snapshotMedia, at most 32 and 400 MiB. The bus is `targetSamples` long: for a
 * keep-visuals render the composition's length (the visuals', or with holdFinalFrame and an overrun, theirs plus the
 * held frame: computeRev, holdTarget); for a fit, the length the agent fits the beats to (fitTargetOf).
 */
async function freezeNarration(
  repo: Repo,
  op: NarrationOp,
  targetSamples: number,
  s: RenderSettings,
  transcriptionProvider: TranscriptionProvider,
  language: Language,
): Promise<FrozenNarration> {
  // Only the selected take of each slot is frozen: alternatives are the draft's, never the render's.
  const clips = resolve(op.clips)
    .filter((c) => c.gainDb !== null && c.start < targetSamples)
    .map(withoutAlternatives)
  const takes: FrozenNarration['takes'] = []
  for (const id of new Set(clips.map((c) => c.mediaId))) {
    const m = await repo.getMedia(id)
    if (!m)
      throw new ApiError('take_deleted', 'A recording this uses was deleted. Record or pick another take.')
    takes.push({
      mediaId: m.id,
      key: m.cleanKey,
      sha256: m.cleanSha256,
      bytes: m.bytes,
      ...(m.license ? { license: m.license } : {}),
    })
  }
  if (takes.length > MAX_NARRATION_TAKES || takes.reduce((n, t) => n + t.bytes, 0) > MAX_FROZEN_TAKE_BYTES)
    throw new ApiError('invalid_request', 'The recordings this narration plays add up to more than 400 MB.')
  return {
    op: { ...op, clips },
    takes,
    recipe: { pipeline: NARRATION_PIPELINE, cleanup: op.cleanup },
    targetSamples,
    captions: s.captions,
    transcriptionProvider,
    language,
  }
}

/**
 * Renders the draft's current edits as the next version (plan v2 §8, §14 rules 19, 21): the composition is frozen
 * into version-owned storage (kept until the version is deleted, so retries work after the draft expires) and one
 * attempt is queued. keep_visuals: a render-unchanged run restores and verifies it, checks it and renders it without
 * changes. fit_to_narration (plan 2026-11-02 §6.4): an authoring run (mode 'author', editedFromN) starts from the same
 * frozen draft and fits the beats to the narration's exact length; the frozen op always replaces the AI voice.
 */
export async function renderEdit(
  deps: Deps,
  p: Principal,
  id: string,
  idemKey?: string,
  input: { [K in keyof RenderSettings]?: RenderSettings[K] | undefined } = {},
) {
  assertCan(p, 'edit:create')
  const settings: RenderSettings = {
    mode: input.mode ?? 'keep_visuals',
    holdFinalFrame: input.holdFinalFrame ?? false,
    captions: input.captions ?? 'sidecar',
    excludeNarration: input.excludeNarration ?? false,
  }
  if (settings.excludeNarration && settings.holdFinalFrame)
    throw new ApiError(
      'invalid_request',
      'A render without the narration has no narration to hold the last frame for.',
    )
  const fit = settings.mode === 'fit_to_narration'
  if (fit && (settings.holdFinalFrame || settings.excludeNarration))
    throw new ApiError(
      'invalid_request',
      'Fitting the video to your narration retimes the visuals to it, so it neither holds the last frame nor leaves the narration out.',
    )
  // Read once, outside the transaction: whether narration is on, and how the run transcribes it (frozen with it).
  const { narrationEnabled: enabled, transcriptionProvider } = await narrationSettings(deps)
  return deps.store.tx(async (repo) => {
    const e0 = await loadEdit(repo, deps, p, id)
    // A replay is the same request for the same rev: a later save, another mode or other settings is a new one.
    const request = { id, rev: e0.rev, ...settings }
    return withIdempotency(repo, deps, p, `edits.render:${id}`, idemKey, request, async () => {
      const e = await loadEdit(repo, deps, p, id, true)
      if (e.renderedN !== null)
        throw new ApiError('conflict', `This draft was already rendered as v${e.renderedN}.`)
      const job = await loadJob(repo, p, e.jobId, true)
      if (await hasUnfinished(repo, e.jobId))
        throw new ApiError('conflict', 'Another version of this video is still in progress.')
      // A held last frame is part of the frozen composition: one beat after the visuals (contract applyHoldFrame).
      const ops = (e.ops as DraftOp[])
        .filter((o) => !settings.excludeNarration || o.op !== 'narration')
        .map((o) => (fit ? replacingAiVoice(o) : o))
      if (fit && !narrationOp(ops)?.clips.length)
        throw new ApiError(
          'invalid_request',
          'Fitting the video to your narration needs recorded narration in the draft. Record or upload some first, or render with your visuals kept.',
        )
      const r = await computeRev(deps, e, ops, repo, { holdFinalFrame: settings.holdFinalFrame })
      // Recorded narration is mixed by the run from frozen inputs; its takes are checked like a save's.
      if (r.track && !enabled) throw narrationOff()
      if (r.track) await checkTakeAccess(repo, p, e, r.track)
      const target = fit && r.track ? fitTargetOf(r.track, r.targetSamples) : r.targetSamples
      const narration = r.track
        ? await freezeNarration(repo, r.track, target, settings, transcriptionProvider, job.language)
        : null
      const n = job.nextVersionN
      // A draft has no narration bus (the run writes it), and a base's bus is never part of the frozen bundle.
      const frozenFile = (path: string) => !excluded(path) && !isReference(path)
      // The same canonical manifest prepare-run and render-job verify: media bytes, caches and stills excluded.
      const manifest = manifestHash(
        r.list.filter((f) => frozenFile(f.path)).map(({ path, sha256 }) => ({ path, sha256 })),
        [],
      )
      // Lines to re-voice in the run; every file but the ones re-voicing writes must come out as frozen. A fit mutes
      // the AI voice (plan 2026-11-02 §6.4), so it re-voices nothing: speaking lines nobody hears only costs time.
      const beats = fit ? [] : r.composition.narration.filter((l) => l.revoice).map((l) => l.beat)
      const revoice = beats.length
        ? {
            beats,
            keptHash: keptHash(
              r.list.map(({ path, sha256 }) => ({ path, sha256 })),
              beats,
            ),
          }
        : null
      // Media stays by reference: the run downloads it from the version's snapshot.
      const files = new Map(r.changed)
      for (const f of r.list)
        if (!files.has(f.path) && frozenFile(f.path)) files.set(f.path, await readEntry(deps, f))
      const archive = writeTarGz(files)
      const key = `${e.jobId}/v${n}/frozen.tar.gz`
      await deps.blobs.set('sources', key, archive, { contentType: 'application/gzip' })
      const now = deps.clock.now().toISOString()
      const base = await repo.getVersion(e.jobId, e.baseN)
      const row: VersionRow = {
        jobId: e.jobId,
        n,
        prompt: fit
          ? `Edited from v${e.baseN} in the browser, then fitted to the recorded narration.`
          : `Edited from v${e.baseN} in the browser.`,
        authorId: p.userId,
        apiKeyId: p.apiKeyId,
        // A re-voiced line may lengthen its beat, so the length is only known once the run has spoken it; a fit
        // makes the beats total its target exactly, whatever was re-voiced.
        targetDurationSec:
          fit && narration
            ? narration.targetSamples / SAMPLE_RATE
            : revoice
              ? null
              : narration
                ? narration.targetSamples / SAMPLE_RATE
                : r.composition.duration,
        parentN: e.baseN,
        webhookUrl: null,
        status: 'queued',
        createdAt: now,
        plan: null,
        // A fit is an authoring run (src/domain/reconciler.ts: author_from_frozen), still edited from the base.
        mode: fit ? 'author' : 'render_unchanged',
        editedFromN: e.baseN,
        frozen: {
          key,
          sha256: sha256Hex(archive),
          manifestHash: manifest,
          editId: e.id,
          ...(revoice ? { revoice } : {}),
          ...(narration ? { narration } : {}),
        },
        // The composition (and any audio in it) is the base's, so its sound and voice-over are too.
        sound: base?.sound ?? 'silent',
        voiceover: base?.voiceover ?? null,
        // The base's engine: an edit renders the base's composition (render-engines §4.2).
        engine: engineOf(base),
      }
      if (base) assertSameEngine(deps, base, row)
      await repo.insertVersion(row)
      await repo.insertVersionMedia(
        await snapshotMedia(repo, e.jobId, n, r.picks, await repo.listVersionMedia(e.jobId, e.baseN)),
      )
      const attempt = newAttempt(deps, e.jobId, n, now)
      await repo.insertAttempt(attempt)
      // The attempt holds the takes it mixes until its version does (finalize promotes the refs).
      if (narration)
        await addAttemptRefs(
          repo,
          deps,
          attempt.id,
          e.jobId,
          narration.takes.map((t) => t.mediaId),
        )
      await repo.updateJob(e.jobId, {
        latestVersion: n,
        nextVersionN: n + 1,
        status: 'queued',
        updatedAt: now,
        version: job.version + 1,
      })
      await repo.updateEdit(e.id, { renderedN: n, updatedAt: now })
      deps.log.info('edit.render', {
        editId: e.id,
        jobId: e.jobId,
        n,
        ops: e.ops.length,
        base: e0.baseN,
        mode: settings.mode,
        ...(settings.excludeNarration ? { excludeNarration: true } : {}),
        ...(narration
          ? {
              takes: narration.takes.length,
              targetSamples: narration.targetSamples,
              hold: settings.holdFinalFrame,
            }
          : {}),
      })
      return { status: 202, body: await videoDto(repo, deps, e.jobId, p) }
    })
  })
}
