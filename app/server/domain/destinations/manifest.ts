// The manifest (publish destinations §2.5): the only data about a video that leaves the app. Written once per
// operation, before any outside work, and never changed. No prompts, plans, feedback, owner emails or other versions.
import type { Deps } from '../../deps.js'
import { sha256Hex } from '../../lib/crypto.js'
import { ApiError } from '../../lib/errors.js'
import type { Repo } from '../../store/types.js'
import { versionCredits, type Credit } from '../credits.js'
import { FILE_NAMES, versionFileName } from '../files.js'
import type { DestinationPublicationRow, JobRow, OutputRow, Target, VersionRow } from '../types.js'

export type ManifestFileKind = 'mp4' | 'poster' | 'captions' | 'transcript'

export interface ManifestFile {
  kind: ManifestFileKind
  contentType: string
  bytes: number
  sha256: string
  /** The stored name under {jobId}/v{n}/ (never sent; used to sign links and stream). */
  name: string
}

export interface PublishManifest {
  v: 1
  action: 'publish'
  video: { id: string; title: string; language: string }
  version: {
    n: number
    title: string
    summary: string
    width: number
    height: number
    durationSec: number
    credits: Credit[]
  }
  files: ManifestFile[]
  sharePage: string | null
}

export interface RemoveManifest {
  v: 1
  action: 'remove'
  externalId: string | null
  url: string | null
  target: Target | null
  connectionId: string | null
}

export type Manifest = PublishManifest | RemoveManifest

const CONTENT_TYPES: Record<ManifestFileKind, string> = {
  mp4: 'video/mp4',
  poster: 'image/jpeg',
  captions: 'text/vtt',
  transcript: 'text/plain',
}

/** Private videos don't go to external destinations (decision 7): their links are short and die on a change. */
export function assertCanLeave(job: Pick<JobRow, 'private'>) {
  if (job.private) throw new ApiError('forbidden', 'Make the video visible to the team first.')
}

/** The stored key of a version's file: the output keys for the render's own files, else {jobId}/v{n}/{name}. */
export function fileKey(job: Pick<JobRow, 'id'>, n: number, o: OutputRow, name: string): string {
  if (name === FILE_NAMES.video) return o.videoKey
  if (name === FILE_NAMES.poster) return o.posterKey
  if (name === FILE_NAMES.captions) return o.captionsKey
  return `${job.id}/v${n}/${name}`
}

export async function buildPublishManifest(
  repo: Repo,
  deps: Pick<Deps, 'blobs' | 'config'>,
  job: JobRow,
  v: VersionRow,
  o: OutputRow,
  opts: { includeTranscript: boolean; sharePage: string | null },
): Promise<PublishManifest> {
  const credits = versionCredits(await repo.versionProvenance(job.id), v, o.runCredits)
  const files: ManifestFile[] = [
    {
      kind: 'mp4',
      contentType: CONTENT_TYPES.mp4,
      bytes: o.bytes,
      sha256: o.sha256[FILE_NAMES.video] ?? '',
      name: FILE_NAMES.video,
    },
  ]
  // The small files are read once to record their exact size and hash (a picked poster or a caption revision has
  // its own name; the output's hash map only covers the render's files).
  const small: [ManifestFileKind, string | null][] = [
    ['poster', versionFileName(v, o, 'poster')],
    ['captions', versionFileName(v, o, 'captions')],
  ]
  if (opts.includeTranscript) small.push(['transcript', versionFileName(v, o, 'transcript')])
  for (const [kind, name] of small) {
    if (!name) continue
    const bytes = await deps.blobs.get('videos', fileKey(job, v.n, o, name))
    if (!bytes) continue
    files.push({
      kind,
      contentType: CONTENT_TYPES[kind],
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      name,
    })
  }
  return {
    v: 1,
    action: 'publish',
    video: { id: job.id, title: o.title || job.title, language: job.language },
    version: {
      n: v.n,
      title: o.title || job.title,
      summary: o.agentSummary.slice(0, 1000),
      width: o.width,
      height: o.height,
      durationSec: o.durationSec,
      credits,
    },
    files,
    sharePage: opts.sharePage,
  }
}

export function buildRemoveManifest(
  p: Pick<DestinationPublicationRow, 'externalId' | 'url' | 'target' | 'connectionId'>,
): RemoveManifest {
  return {
    v: 1,
    action: 'remove',
    externalId: p.externalId,
    url: p.url,
    target: p.target,
    connectionId: p.connectionId,
  }
}

/** The manifest as a receiver sees it: each file with a signed link instead of its stored name. */
export function publicManifest(m: PublishManifest, links: Record<string, string>) {
  return {
    video: m.video,
    version: m.version,
    files: m.files.map(({ kind, contentType, bytes, sha256 }) => ({
      kind,
      contentType,
      bytes,
      sha256,
      url: links[kind] ?? null,
    })),
    sharePage: m.sharePage,
  }
}
