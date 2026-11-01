// Edit drafts (plan v2 §8): each person edits their own draft of a finished contract-1 version. Every save sends the
// whole list of operations; the server re-applies them to the version's bundle with the same patcher the browser
// uses and stores an immutable bundle for that rev, which the preview plays and a render freezes.
import type { Deps } from '../deps.js'
import { excluded, manifestHash } from '../lib/bundle-manifest.js'
import { applyEdits, ContractError, type EditOp, type Summary } from '../lib/contract.js'
import { signPath, sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { writeTarGz } from '../lib/tar.js'
import { PREVIEW_TTL_SEC, previewScope } from '../lib/preview.js'
import { contextMeta } from '../generated/context.js'
import { bundleFileKey, bundlePrefix, contractOf, ensureBundle, type BundleIndex } from './bundles.js'
import { assertCan, type Principal } from './policy.js'
import { getSettings } from './settings.js'
import type { Repo } from '../store/types.js'
import type { EditRow } from './types.js'
import { hasUnfinished, loadJob, newAttempt, videoDto, withIdempotency } from './videos.js'

export const EDIT_TTL_MS = 7 * 24 * 3600_000
const MAX_OPS = 500

export const editPrefix = (jobId: string, n: number, editId: string) =>
  `${bundlePrefix(jobId, n)}e/${editId}/`
export const editRevPrefix = (jobId: string, n: number, editId: string, rev: number) =>
  `${editPrefix(jobId, n, editId)}r${rev}/`
/** What a draft preview capability signs: one draft, never the version or other drafts. */
export const editScope = (jobId: string, n: number, editId: string) => `${previewScope(jobId, n)}/e/${editId}`

/** The base version's composition files, from its preview bundle. */
async function baseFiles(deps: Deps, jobId: string, n: number) {
  const index = await ensureBundle(deps, jobId, n)
  if (!index) throw new ApiError('not_found', "This version's composition isn't available.")
  const files = new Map<string, Uint8Array>()
  for (const f of index.files) {
    const b = await deps.blobs.get('bundles', bundleFileKey(jobId, n, f.path))
    if (!b) throw new ApiError('conflict', "This version's composition is incomplete. Try again later.")
    files.set(f.path, b)
  }
  return files
}

const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : '')

/** Colours a role may take: the ones the composition already uses, plus the brand's primary colour. */
export function paletteOf(colors: Record<string, string>) {
  return [...new Set([...Object.values(colors), contextMeta.primaryColor].map((c) => c.trim().toLowerCase()))]
}

/**
 * Applies the ops to the base (in memory). Throws ApiError (400, with the contract violations) when an edit would
 * break the composition.
 */
async function computeRev(deps: Deps, e: Pick<EditRow, 'jobId' | 'baseN'>, ops: EditOp[]) {
  const files = await baseFiles(deps, e.jobId, e.baseN)
  const html = text(files.get('index.html'))
  const summary = JSON.parse(text(files.get('summary.json')) || '{}') as Summary
  const base = applyEdits(html, summary, [], {})
  const palette = paletteOf(base.composition.colors)
  const baseComposition = base.composition
  let out
  try {
    out = applyEdits(html, summary, ops, { palette })
  } catch (err) {
    if (err instanceof ContractError)
      throw new ApiError('invalid_request', `That edit can't be made: ${err.violations.join(' ')}`, {
        violations: err.violations,
      })
    throw err
  }
  files.set('index.html', new TextEncoder().encode(out.html))
  files.set('summary.json', new TextEncoder().encode(JSON.stringify(out.summary, null, 2)))
  const list = [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: sha256Hex(bytes) }))
  return {
    files,
    list,
    composition: out.composition,
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
async function buildRev(deps: Deps, e: Pick<EditRow, 'id' | 'jobId' | 'baseN'>, rev: number, ops: EditOp[]) {
  const r = await computeRev(deps, e, ops)
  const { files, list } = r
  const prefix = editRevPrefix(e.jobId, e.baseN, e.id, rev)
  for (const [path, bytes] of files) await deps.blobs.set('bundles', `${prefix}f/${path}`, bytes)
  const index: BundleIndex = {
    v: 1,
    jobId: e.jobId,
    versionN: e.baseN,
    files: list,
    createdAt: deps.clock.now().toISOString(),
    contract: contractOf(files),
  }
  await deps.blobs.set('bundles', `${prefix}manifest.json`, JSON.stringify(index), {
    contentType: 'application/json',
  })
  // Only the newest rev is kept.
  for (const k of await deps.blobs.list('bundles', editPrefix(e.jobId, e.baseN, e.id)))
    if (!k.startsWith(prefix)) await deps.blobs.delete('bundles', k)
  return r
}

async function editDto(deps: Deps, e: EditRow, built?: Rev) {
  const job = await deps.store.getJob(e.jobId)
  // Reads recompute in memory; only saves write bundles.
  const b = built ?? (await computeRev(deps, e, e.ops as EditOp[]))
  return {
    id: e.id,
    videoId: e.jobId,
    baseN: e.baseN,
    rev: e.rev,
    ops: e.ops as EditOp[],
    composition: b.composition,
    // The version as it was: the editor diffs against it to build the op list.
    base: b.base,
    palette: b.palette,
    expiresAt: e.expiresAt,
    renderedN: e.renderedN,
    // Someone else rendered (or revised) since this draft started: "start from vN, or render yours as vN+1".
    newerVersion: job && job.latestVersion > e.baseN ? job.latestVersion : null,
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
export async function saveEdit(deps: Deps, p: Principal, id: string, input: { ops: EditOp[]; rev: number }) {
  assertCan(p, 'edit:create')
  if (input.ops.length > MAX_OPS) throw new ApiError('invalid_request', `At most ${MAX_OPS} edits per draft.`)
  return deps.store.tx(async (repo) => {
    const e = await loadEdit(repo, deps, p, id, true)
    if (e.renderedN !== null)
      throw new ApiError('conflict', `This draft was already rendered as v${e.renderedN}.`)
    if (input.rev !== e.rev)
      throw new ApiError('conflict', 'This draft changed in another tab. Reload it to continue.', {
        rev: e.rev,
      })
    const rev = e.rev + 1
    const built = await buildRev(deps, e, rev, input.ops)
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
    return editDto(deps, next, built)
  })
}

export async function discardEdit(deps: Deps, p: Principal, id: string) {
  const e = await loadEdit(deps.store, deps, p, id)
  for (const k of await deps.blobs.list('bundles', editPrefix(e.jobId, e.baseN, e.id)))
    await deps.blobs.delete('bundles', k)
  await deps.store.deleteEdit(id)
}

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

/** Sweep: expired drafts go, with their bundles. */
export async function deleteExpiredEdits(deps: Deps, limit = 20) {
  for (const e of await deps.store.listExpiredEdits(deps.clock.now().toISOString(), limit)) {
    for (const k of await deps.blobs.list('bundles', editPrefix(e.jobId, e.baseN, e.id)))
      await deps.blobs.delete('bundles', k)
    await deps.store.deleteEdit(e.id)
  }
}

/**
 * Renders the draft's current edits as the next version (plan v2 §8, §14 rules 19, 21): the composition is frozen
 * into version-owned storage (kept until the version is deleted, so retries work after the draft expires) and one
 * render-unchanged attempt is queued. The run restores and verifies it, checks it and renders it without changes.
 */
export async function renderEdit(deps: Deps, p: Principal, id: string, idemKey?: string) {
  assertCan(p, 'edit:create')
  return deps.store.tx(async (repo) => {
    const e0 = await loadEdit(repo, deps, p, id)
    return withIdempotency(repo, deps, p, `edits.render:${id}`, idemKey, { id }, async () => {
      const e = await loadEdit(repo, deps, p, id, true)
      if (e.renderedN !== null)
        throw new ApiError('conflict', `This draft was already rendered as v${e.renderedN}.`)
      const job = await loadJob(repo, p, e.jobId, true)
      if (await hasUnfinished(repo, e.jobId))
        throw new ApiError('conflict', 'Another version of this video is still in progress.')
      const r = await computeRev(deps, e, e.ops as EditOp[])
      const n = job.nextVersionN
      // The same canonical manifest prepare-run and render-job verify: media bytes, caches and stills excluded.
      const manifest = manifestHash(
        r.list.filter((f) => !excluded(f.path)).map(({ path, sha256 }) => ({ path, sha256 })),
        [],
      )
      const archive = writeTarGz(r.files)
      const key = `${e.jobId}/v${n}/frozen.tar.gz`
      await deps.blobs.set('sources', key, archive, { contentType: 'application/gzip' })
      const now = deps.clock.now().toISOString()
      await repo.insertVersion({
        jobId: e.jobId,
        n,
        prompt: `Edited from v${e.baseN} in the browser.`,
        authorId: p.userId,
        apiKeyId: p.apiKeyId,
        targetDurationSec: r.composition.duration,
        parentN: e.baseN,
        webhookUrl: null,
        status: 'queued',
        createdAt: now,
        plan: null,
        mode: 'render_unchanged',
        editedFromN: e.baseN,
        frozen: { key, sha256: sha256Hex(archive), manifestHash: manifest, editId: e.id },
      })
      await repo.insertAttempt(newAttempt(deps, e.jobId, n, now))
      await repo.updateJob(e.jobId, {
        latestVersion: n,
        nextVersionN: n + 1,
        status: 'queued',
        updatedAt: now,
        version: job.version + 1,
      })
      await repo.updateEdit(e.id, { renderedN: n, updatedAt: now })
      deps.log.info('edit.render', { editId: e.id, jobId: e.jobId, n, ops: e.ops.length, base: e0.baseN })
      return { status: 202, body: await videoDto(repo, deps, e.jobId, p) }
    })
  })
}
