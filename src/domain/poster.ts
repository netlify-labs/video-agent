// A picked poster: a frame someone chose while scrubbing, or an image they uploaded. The browser makes the files (a
// JPEG up to 1920 px wide, 480w and 960w WebPs when it can encode them, and the blurred placeholder), cropped to the
// video's shape; here they're checked and stored under new immutable names (poster.r<k>.jpg, poster-480.r<k>.webp,
// poster-960.r<k>.webp) next to the render's, which stay as they were. Like a caption revision (captions.ts): the
// files are written ahead of the commit, versions.poster records the pick, and the video's ETag moves.
//
// A published version's share page follows at once: its mirror (pub/<slug>.json) is rewritten inside the transaction,
// under the job's lock, which publishing, unpublishing and the caption sync take too, so none overwrites another.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import { classify } from '../lib/media/classify.js'
import { isLqip } from '../lib/media/previews.js'
import type { Repo } from '../store/types.js'
import { assertCan, type Principal } from './policy.js'
import { posterKeys, posterLqip } from './files.js'
import type { JobRow, VersionPoster } from './types.js'
import { loadJob, pubKey, type PublicationMirror } from './videos.js'

/** Each file's limit; a 1920 px JPEG of a busy frame is a few hundred kB. */
const MAX_FILE_BYTES = 3 * 1024 * 1024
const MIN_WIDTH = 320
const MAX_WIDTH = 1920
/** How far an image's shape may be from the video's (rounding to whole pixels). */
const ASPECT_SLACK = 0.02

export interface SetPosterInput {
  source: 'frame' | 'upload'
  at?: number | undefined
  /** Base64 file bytes. */
  jpg: string
  webp480?: string | undefined
  webp960?: string | undefined
  lqip?: string | undefined
}

const fileKey = (jobId: string, n: number, name: string) => `${jobId}/v${n}/${name}`

function decode(field: string, b64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new ApiError('invalid_request', `${field} isn't base64.`)
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
  if (bytes.byteLength > MAX_FILE_BYTES)
    throw new ApiError('invalid_request', `${field} must be ${MAX_FILE_BYTES / 1024 / 1024} MB or smaller.`)
  return bytes
}

/** Checks one image: its type, its width range and that its shape is the video's. */
function checkImage(
  field: string,
  bytes: Uint8Array,
  ext: 'jpg' | 'webp',
  widths: { min: number; max: number },
  video: { width: number; height: number },
) {
  let info
  try {
    info = classify(bytes)
  } catch {
    throw new ApiError('invalid_request', `${field} couldn't be read.`)
  }
  if (info.kind !== 'image' || info.ext !== ext || !info.width || !info.height)
    throw new ApiError('invalid_request', `${field} must be a ${ext === 'jpg' ? 'JPEG' : 'WebP'} image.`)
  if (info.width < widths.min || info.width > widths.max)
    throw new ApiError('invalid_request', `${field} must be ${widths.min} to ${widths.max} px wide.`)
  const want = video.width / video.height
  if (Math.abs(info.width / info.height - want) / want > ASPECT_SLACK)
    throw new ApiError(
      'invalid_request',
      `${field} must have the video's shape (${video.width}×${video.height}).`,
    )
}

/** Rewrites a published version's mirror to the version's current poster. Under the job's lock (the caller's tx). */
async function syncMirrors(
  deps: Pick<Deps, 'blobs'>,
  repo: Repo,
  job: JobRow,
  n: number,
  poster: VersionPoster,
) {
  const pubs = (await repo.listPublications(job.id)).filter((p) => p.versionN === n && !p.unpublishedAt)
  const output = pubs.length ? await repo.getOutput(job.id, n) : null
  for (const p of pubs) {
    const raw = await deps.blobs.get('internal', pubKey(p.slug))
    if (!raw || !output) continue
    const mirror = JSON.parse(new TextDecoder().decode(raw)) as PublicationMirror
    const keys = posterKeys(job.id, n, output, poster)
    await deps.blobs.set(
      'internal',
      pubKey(p.slug),
      JSON.stringify({
        ...mirror,
        keys: { ...mirror.keys, ...keys },
        lqip: posterLqip(output, poster),
      } satisfies PublicationMirror),
    )
  }
  return pubs.length
}

async function loadForPoster(repo: Repo, principal: Principal, jobId: string, n: number) {
  const job = await loadJob(repo, principal, jobId, true)
  assertCan(principal, 'video:rename', { ownerId: job.ownerId })
  const pubs = (await repo.listPublications(jobId)).filter((p) => p.versionN === n && !p.unpublishedAt)
  // A published version's poster is public: changing it is the publish power (owner or admin).
  if (pubs.length) assertCan(principal, 'video:publish', { ownerId: job.ownerId })
  const version = await repo.getVersion(jobId, n)
  const output = await repo.getOutput(jobId, n)
  if (!version || version.status !== 'ready' || !output)
    throw new ApiError('not_ready', 'Only ready versions have a poster.')
  return { job, version, output }
}

/** PUT /api/v1/videos/:id/versions/:n/poster. Returns the new versions.poster. */
export async function setPoster(
  deps: Deps,
  principal: Principal,
  jobId: string,
  n: number,
  input: SetPosterInput,
): Promise<VersionPoster> {
  const { poster, published } = await deps.store.tx(async (repo) => {
    const { job, version, output } = await loadForPoster(repo, principal, jobId, n)
    const video = { width: output.width, height: output.height }
    if (
      input.source === 'frame' &&
      (input.at === undefined || input.at < 0 || input.at > output.durationSec + 0.5)
    )
      throw new ApiError('invalid_request', 'at must be a second inside the video.')
    if (input.lqip !== undefined && !isLqip(input.lqip))
      throw new ApiError('invalid_request', 'lqip must be a small WebP or JPEG data URI.')
    const jpg = decode('jpg', input.jpg)
    checkImage('jpg', jpg, 'jpg', { min: MIN_WIDTH, max: MAX_WIDTH }, video)
    const webps = (
      [
        ['webp480', input.webp480, 480],
        ['webp960', input.webp960, 960],
      ] as const
    ).map(([field, b64, w]) => {
      if (b64 === undefined) return null
      const bytes = decode(field, b64)
      // Never wider than the video (a 720 px wide video's "960" is 720).
      checkImage(field, bytes, 'webp', { min: Math.min(w, output.width) - 2, max: w }, video)
      return bytes
    })

    const k = (version.poster?.rev ?? 0) + 1
    const files = {
      jpg: `poster.r${k}.jpg`,
      webp480: webps[0] ? `poster-480.r${k}.webp` : null,
      webp960: webps[1] ? `poster-960.r${k}.webp` : null,
    }
    // New names, so never seen before: written ahead of the commit, and an aborted one is just an unused file (the
    // video's deletion takes its whole prefix).
    const write = (name: string, bytes: Uint8Array, contentType: string) =>
      deps.blobs.set('videos', fileKey(jobId, n, name), bytes, {
        contentType,
        size: String(bytes.byteLength),
      })
    await write(files.jpg, jpg, 'image/jpeg')
    if (files.webp480 && webps[0]) await write(files.webp480, webps[0], 'image/webp')
    if (files.webp960 && webps[1]) await write(files.webp960, webps[1], 'image/webp')

    const poster: VersionPoster = {
      rev: k,
      custom: {
        source: input.source,
        at: input.source === 'frame' ? (input.at ?? null) : null,
        files,
        lqip: input.lqip ?? null,
      },
    }
    await repo.updateVersion(jobId, n, { poster })
    // The video's ETag moves, so readers refetch the DTO with the new poster's links.
    await repo.updateJob(jobId, { version: job.version + 1 })
    return { poster, published: await syncMirrors(deps, repo, job, n, poster) }
  })
  deps.log.info('poster.set', { jobId, versionN: n, rev: poster.rev, source: input.source, published })
  return poster
}

/** DELETE /api/v1/videos/:id/versions/:n/poster: back to the render's poster. Its files stay (immutable names). */
export async function resetPoster(
  deps: Deps,
  principal: Principal,
  jobId: string,
  n: number,
): Promise<VersionPoster> {
  const { poster, published } = await deps.store.tx(async (repo) => {
    const { job, version } = await loadForPoster(repo, principal, jobId, n)
    const poster: VersionPoster = { rev: version.poster?.rev ?? 0, custom: null }
    if (!version.poster?.custom) return { poster, published: 0 }
    await repo.updateVersion(jobId, n, { poster })
    await repo.updateJob(jobId, { version: job.version + 1 })
    return { poster, published: await syncMirrors(deps, repo, job, n, poster) }
  })
  deps.log.info('poster.reset', { jobId, versionN: n, rev: poster.rev, published })
  return poster
}
