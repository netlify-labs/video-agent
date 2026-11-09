// Rebase onto vN (plan 2026-11-02 §2.7 Stale base): the caller's narration op moves from their draft to their draft
// of a newer version (opened, or created, the way the editor opens one), and is saved there through saveEdit, so it's
// revalidated like any save: the narration lock, who may place each take, the takes' bounds and the output limit
// against the new base. The old draft is left as it was; a refused rebase leaves no new draft behind. A draft rendered
// picture first (renderEdit's excludeNarration, §2.1) still has its narration to move: onto the version it made.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import type { NarrationOp } from '../lib/timeline.js'
import { discardEdit, getEdit, openEdit, saveEdit } from './edits.js'
import { assertCan, type Principal } from './policy.js'

export async function rebaseNarration(deps: Deps, p: Principal, id: string, input: { toN: number }) {
  assertCan(p, 'edit:create')
  const from = await getEdit(deps, p, id)
  if (
    from.renderedN !== null &&
    !(await pictureFirst(deps, from.videoId, from.id, from.renderedN, input.toN))
  )
    throw new ApiError('conflict', `This draft was already rendered as v${from.renderedN}.`)
  const track = from.ops.find((o): o is NarrationOp => o.op === 'narration')
  if (!track) throw new ApiError('invalid_request', 'This draft has no narration to rebase.')
  if (input.toN === from.baseN)
    throw new ApiError('invalid_request', `This draft is already on v${input.toN}.`)
  const opened = await openEdit(deps, p, from.videoId, input.toN)
  const to = opened.edit
  try {
    const saved = await saveEdit(deps, p, to.id, {
      ops: [...to.ops.filter((o) => o.op !== 'narration'), track],
      rev: to.rev,
    })
    deps.log.info('edit.rebase_narration', {
      editId: id,
      toEditId: to.id,
      jobId: from.videoId,
      fromN: from.baseN,
      toN: input.toN,
      clips: track.clips.length,
    })
    return { created: opened.created, edit: saved }
  } catch (err) {
    if (opened.created) await discardEdit(deps, p, to.id)
    deps.log.info('edit.rebase_narration_refused', {
      editId: id,
      jobId: from.videoId,
      toN: input.toN,
      code: err instanceof ApiError ? err.code : 'internal',
    })
    if (err instanceof ApiError)
      throw new ApiError(err.code, `Your narration can't move to v${input.toN}: ${err.message}`, err.details)
    throw err
  }
}

/** Whether draft `editId` was rendered as v`renderedN` without its narration (Render picture first), onto v`toN`. */
async function pictureFirst(deps: Deps, jobId: string, editId: string, renderedN: number, toN: number) {
  if (toN !== renderedN) return false
  const v = await deps.store.getVersion(jobId, renderedN)
  return !!v?.frozen && v.frozen.editId === editId && !v.frozen.narration
}
