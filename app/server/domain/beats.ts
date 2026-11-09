// Which scenes a version has (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.2): the beats of its saved
// composition, read once (at finalize, or on first request for older versions) and stored on the version, so the
// video DTO and scoped revisions never unpack an archive.
import type { Deps } from '../deps.js'
import { load, read } from '../lib/contract.js'
import { ApiError } from '../lib/errors.js'
import { bundleFileKey, ensureBundle } from './bundles.js'
import type { Principal } from './policy.js'
import type { BeatInfo } from './types.js'
import { loadJob } from './videos.js'

/** The beats of a composition's files; null unless index.html declares editing contract v1 and can be read. */
export function beatsOf(files: Map<string, Uint8Array>): BeatInfo[] | null {
  const raw = files.get('index.html')
  if (!raw) return null
  const html = new TextDecoder().decode(raw)
  if (!/data-va-contract\s*=\s*["']1["']/.test(html)) return null
  try {
    // The held last frame (va-hold) is listed too: a scoped revision has to see it to refuse it.
    return read(load(html)).beats.map((b) => ({
      id: b.id,
      label: b.label,
      start: b.start,
      duration: b.duration,
    }))
  } catch {
    return null
  }
}

/**
 * A version's beats for someone who can see the video, filled and stored on first read for versions made before
 * finalize recorded them (plan §4.2). Never inside a transaction: the fill unpacks the archive (Blobs I/O). The
 * visibility check comes first, so nobody can make the server unpack a video they can't see. Only an editable
 * (contract-v1) version is unpacked; any other has no beats, since it can't be redone scene by scene anyway.
 */
export async function fillBeats(
  deps: Pick<Deps, 'blobs' | 'store' | 'clock' | 'log'>,
  principal: Principal,
  jobId: string,
  n: number,
): Promise<BeatInfo[] | null> {
  const started = Date.now()
  await loadJob(deps.store, principal, jobId)
  const version = await deps.store.getVersion(jobId, n)
  if (!version) throw new ApiError('not_found', `Version ${n} not found.`)
  if (version.status !== 'ready') throw new ApiError('not_ready', `Version ${n} isn't ready yet.`)
  const log = (cached: boolean, filled: boolean) =>
    deps.log.info('beats.fill', { jobId, n, cached, filled, ms: Date.now() - started })
  if (version.beats) {
    log(true, false)
    return version.beats
  }
  if (version.contract !== 1) {
    log(false, false)
    return null
  }
  const bundle = await ensureBundle(deps, jobId, n)
  const html = bundle ? await deps.blobs.get('bundles', bundleFileKey(jobId, n, 'index.html')) : null
  const beats = html ? beatsOf(new Map([['index.html', html]])) : null
  // Only beats: the contract was decided at finalize (or by the bundle) and isn't re-derived here.
  if (beats) await deps.store.updateVersion(jobId, n, { beats })
  log(false, beats !== null)
  return beats
}
