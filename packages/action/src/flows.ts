// What the action does for each decision (github-action plan §3.5-3.11; beads va-mg4i.2.7-2.15): find the PR's or
// release's video, or create one (budgets, screenshots, brief, create, race check, private), follow it, and show the
// result where it belongs: the sticky PR comment, the release notes, or only the job summary.
import {
  dispatchBrief,
  prBrief,
  prTitle,
  releaseBrief,
  releaseTitle,
  remixBrief,
  reviseBrief,
  describeRemoved,
  type Brief,
  type Target as RefTarget,
} from '../../cli/src/brief/index.js'
import { isVideoAgentError, VideoAgent, type VideoAgentError } from '../../sdk/src/index.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBudget, type BudgetResult } from './budget.js'
import { creditsOf, publication, renderComment, upsertComment, type CommentState } from './comment.js'
import { follow, type Followed } from './follow.js'
import type { GitHub } from './github.js'
import type { Inputs } from './inputs.js'
import { setOutputs, type Run } from './main.js'
import { readSection, renderSection, withSection } from './release.js'
import { cleanup, fromBody, fromGlob, prepare, type Prepared, type Shot } from './screenshots.js'
import { ACTION_VERSION } from './spec.js'
import {
  findOwnComment,
  findVideo,
  identity,
  keys,
  latest,
  latestReady,
  lookupAll,
  parseMarker,
  type Marker,
  type Version,
  type Video,
} from './state.js'

/** At most two attempts per version: a timed-out attempt already spent a full authoring deadline (§5). */
export const MAX_ATTEMPTS = 2

/** Where the result shows. */
interface Surface {
  show(state: CommentState): Promise<void>
}

export interface PrInfo {
  number: number
  title: string
  body: string
  headSha: string
  commits: string[]
  files: string[]
  filesTotal: number
  authorTrusted: boolean
}

export interface Ctx {
  run: Run
  inputs: Inputs
  gh: GitHub
  va: VideoAgent
  features: readonly string[]
}

export function client(run: Run, inputs: Inputs): VideoAgent {
  return new VideoAgent({
    url: inputs.url,
    apiKey: inputs.apiKey,
    userAgent: `video-agent-action/${ACTION_VERSION}`,
    fetch: run.deps.fetch,
    logger: (_event, f) => {
      run.log.api({
        method: String(f.method),
        path: String(f.path),
        status: Number(f.status),
        ms: Number(f.ms),
        attempt: Number(f.attempt),
      })
    },
  })
}

const webUrl = (ctx: Ctx, id: string) => `${ctx.inputs.url}/videos/${id}`

const failedStatus = (v: Version) =>
  v.status === 'timed_out' ? 'timed_out' : v.status === 'cancelled' ? 'cancelled' : 'failed'

/** Outputs and the job summary for a video's state. */
function report(
  ctx: Ctx,
  o: {
    status: string
    video?: Video
    version?: Version
    created?: boolean
    prompt?: string
    commentId?: number
  },
) {
  const { run } = ctx
  const v = o.version
  const pub = v ? publication(v) : null
  setOutputs(run, {
    status: o.status,
    ...(o.video ? { 'video-id': o.video.id, 'web-url': webUrl(ctx, o.video.id) } : {}),
    ...(v ? { version: String(v.n), credits: String(creditsOf(v)) } : {}),
    ...(v?.output ? { 'duration-sec': String(v.output.durationSec) } : {}),
    ...(pub
      ? { 'share-url': pub.page, 'mp4-url': pub.mp4, 'gif-url': pub.gif, 'poster-url': pub.poster }
      : {}),
    ...(o.created !== undefined ? { created: String(o.created) } : {}),
    ...(o.prompt ? { prompt: o.prompt } : {}),
    ...(o.commentId ? { 'comment-id': String(o.commentId) } : {}),
  })
  const lines = [`### Video Agent: ${o.status}`, '']
  if (o.video) lines.push(`- Video: [${o.video.title}](${webUrl(ctx, o.video.id)})`)
  if (v) {
    lines.push(`- Version: v${v.n}${v.output ? `, ${Math.round(v.output.durationSec)} s` : ''}`)
    lines.push(`- Credits: ${v.status === 'ready' ? '' : 'at least '}${creditsOf(v)}`)
    for (const c of v.credits) lines.push(`- ${c.text}`)
  }
  if (pub) lines.push(`- Share page: ${pub.page}`, '', `![poster](${pub.poster})`)
  if (o.prompt)
    lines.push('', '<details><summary>The brief</summary>', '', '```text', o.prompt, '```', '', '</details>')
  run.deps.core.summary(lines.join('\n'))
}

/** The API's errors that mean the setup is wrong: fail the step with a message that says what to fix. */
export async function setupError(
  ctx: { run: Run; va?: VideoAgent | undefined },
  e: VideoAgentError,
): Promise<string | null> {
  if (e.status === 401 || e.status === 403)
    return `${e.message} (the CI account needs the Creator role, and the key must be active)`
  if (e.status === 503) {
    const config = await ctx.va?.raw.GET('/api/v1/config').catch(() => null)
    const missing = (config?.data as { missingSettings?: string[] } | undefined)?.missingSettings ?? []
    return `the Video Agent site isn't set up yet${missing.length ? `: missing ${missing.join(', ')}` : ''}`
  }
  return null
}

// ───── creating and following ─────

interface Made {
  video: Video
  n: number
  uploaded: string[]
}

/** Budgets, then screenshots, then create, then the race check and privacy. Null when a cap stopped it. */
async function create(
  ctx: Ctx,
  o: {
    target: RefTarget | null
    brief: (captions: string[]) => Brief
    title: string | undefined
    durationSec: number
    key: string
    shots: () => Promise<Shot[]>
    surface: Surface
    marker: (videoId: string, pending: string[]) => Marker
    /** With base-video: what the remix is for and the changes to show (bead va-mg4i.3.2). */
    remix?: { label: string; changes: () => string }
  },
): Promise<Made | 'stopped' | 'dry-run'> {
  const { run, inputs, va } = ctx
  const budget = await checkBudget(run, va, inputs, { newVersion: true })
  if (!budget.ok && !inputs.dryRun) {
    await showCap(ctx, o.surface, budget)
    return 'stopped'
  }
  const shots = await o.shots()
  if (inputs.dryRun) {
    const brief = o.brief(shots.map((s, i) => `screenshot ${i + 1}${s.alt ? `: ${s.alt}` : ''}`))
    dryRun(ctx, brief, [
      ...shots.map(
        (s) =>
          `POST /api/v1/media (${s.ext}, ${s.bytes.byteLength} bytes from ${s.source}) unless already in the library`,
      ),
      inputs.baseVideo && o.remix
        ? `POST /api/v1/videos/${inputs.baseVideo}/remix (Idempotency-Key ${o.key}), then PATCH its title "${o.title ?? ''}"`
        : `POST /api/v1/videos (prompt ${brief.prompt.length} characters, title "${o.title ?? ''}", ${o.durationSec} s, ${inputs.aspect}, Idempotency-Key ${o.key})`,
      ...(inputs.private ? ['PATCH /api/v1/videos/{id} { private: true }'] : []),
    ])
    return 'dry-run'
  }
  if (inputs.baseVideo && o.remix) return remixBase(ctx, o, o.remix, shots)
  const prepared: Prepared = shots.length
    ? await prepare(run, va, shots, o.target?.kind === 'pr' ? o.target.number : null)
    : { mediaIds: [], uploaded: [], captions: [] }
  const brief = o.brief(prepared.captions)
  logBrief(run, brief)
  await run.deps.hook?.('before-create')
  const made = await va.videos.create(
    {
      prompt: brief.prompt,
      ...(o.title ? { title: o.title } : {}),
      aspect: inputs.aspect,
      durationSec: o.durationSec,
      ...(prepared.mediaIds.length ? { mediaIds: prepared.mediaIds.slice(0, 12) } : {}),
    },
    { idempotencyKey: o.key },
  )
  // A replay returns the response stored at creation: read the video as it is now.
  let video = await va.videos.get(made.id)
  run.log.decision('created', { video: video.id, key: o.key })
  // Private right away (the API has no private on create before phase 3's external_ref).
  if (inputs.private) video = await va.videos.update(video.id, { private: true })
  setOutputs(run, { prompt: brief.prompt, 'video-id': video.id })
  if (o.target) {
    const settled = await settle(ctx, o.target, video, prepared.uploaded)
    if (settled.adopted) return { video: settled.adopted, n: settled.adopted.latestVersion, uploaded: [] }
  }
  return { video, n: 1, uploaded: prepared.uploaded }
}

/**
 * base-video (bead va-mg4i.3.2): a remix of a house-format video instead of a new one. Shape, length, sound and look come
 * from the base unless the inputs set them; remix has no title, so it's set (with private) right after.
 */
async function remixBase(
  ctx: Ctx,
  o: Parameters<typeof create>[1],
  r: { label: string; changes: () => string },
  shots: Shot[],
): Promise<Made | 'stopped'> {
  const { run, inputs, va } = ctx
  const base = inputs.baseVideo
  try {
    await va.videos.get(base)
  } catch (e) {
    if (isVideoAgentError(e) && e.status === 404)
      throw new Error(`base-video ${base} not found or not visible to the CI account`, { cause: e })
    throw e
  }
  const prepared: Prepared = shots.length
    ? await prepare(run, va, shots, o.target?.kind === 'pr' ? o.target.number : null)
    : { mediaIds: [], uploaded: [], captions: [] }
  const brief = remixBrief({
    target: o.target ?? { kind: 'pr', owner: ctx.gh.owner, repo: ctx.gh.repo, number: 0 },
    label: r.label,
    changes: r.changes(),
    extra: inputs.prompt,
  })
  logBrief(run, brief)
  await run.deps.hook?.('before-create')
  let made: Video
  try {
    made = await va.videos.remix(
      base,
      {
        prompt: brief.prompt,
        // Only what the workflow set: the base's own shape and length otherwise.
        ...(inputs.aspect !== '16:9' ? { aspect: inputs.aspect } : {}),
        ...(inputs.duration ? { durationSec: inputs.duration } : {}),
        ...(prepared.mediaIds.length ? { mediaIds: prepared.mediaIds.slice(0, 12) } : {}),
      },
      { idempotencyKey: o.key },
    )
  } catch (e) {
    if (isVideoAgentError(e) && (e.code === 'remix_disabled' || e.code === 'unsupported_by_server')) {
      if (prepared.uploaded.length) await cleanup(run, va, prepared.uploaded)
      run.log.decision('stopped', {
        reason: 'remixing is off: drop base-video or ask an admin to turn remixing on',
      })
      run.log.warn(
        'remixing is turned off on this server: drop base-video or ask an admin to turn remixing on',
      )
      report(ctx, { status: 'skipped' })
      return 'stopped'
    }
    throw e
  }
  let video = await va.videos.update(made.id, {
    ...(o.title ? { title: o.title } : {}),
    ...(inputs.private ? { private: true } : {}),
  })
  run.log.decision('remixed', { video: video.id, base, key: o.key })
  setOutputs(run, { prompt: brief.prompt, 'video-id': video.id })
  if (o.target) {
    const settled = await settle(ctx, o.target, video, prepared.uploaded)
    if (settled.adopted) return { video: settled.adopted, n: settled.adopted.latestVersion, uploaded: [] }
  }
  video = await va.videos.get(video.id)
  return { video, n: 1, uploaded: prepared.uploaded }
}

/**
 * The post-create race check (bead va-mg4i.2.8): a label event and a /video command can both look up, find nothing and
 * create. Both look again; the oldest (createdAt, then id) survives, the newer cancels its run and deletes itself.
 */
async function settle(
  ctx: Ctx,
  target: RefTarget,
  mine: Video,
  uploaded: string[],
): Promise<{ adopted: Video | null }> {
  const { run, va } = ctx
  await run.deps.hook?.('before-settle')
  const all = await lookupAll(va, target)
  const oldest = all[0]
  if (!oldest || oldest.id === mine.id) {
    if (all.length > 1) run.log.line({ race: 'won', video: mine.id, others: all.length - 1 })
    return { adopted: null }
  }
  const v1 = mine.versions.find((x) => x.n === 1)
  await va.versions.cancel(mine.id, 1).catch(() => undefined)
  const after = await va.videos.get(mine.id).catch(() => null)
  const ran = after?.versions.find((x) => x.n === 1)
  await va.videos.delete(mine.id).catch(() => undefined)
  if (uploaded.length) await cleanup(run, va, uploaded)
  run.log.line({ race: 'lost', adopted: oldest.id, deleted: mine.id })
  if (
    ran &&
    (ran.attempts > 0 || ran.status !== 'cancelled' || v1?.status !== 'queued') &&
    creditsOf(ran) > 0
  )
    run.log.warn(`a duplicate run was stopped (at least ${creditsOf(ran)} credits)`)
  return { adopted: await va.videos.get(oldest.id) }
}

/** Follows version n and shows each state change; cleans up screenshots when it's done. */
async function followAndShow(
  ctx: Ctx,
  made: { video: Video; n: number; uploaded: string[] },
  surface: Surface,
  o: {
    created: boolean
    prompt?: string
    marker: (pending: string[]) => Marker
    saveMarker: (m: Marker) => void
    /** Runs once the version is ready (and published, when asked): release assets. */
    afterReady?: (video: Video, version: Version) => Promise<void>
  },
): Promise<string> {
  const { run, inputs, va } = ctx
  const timeoutMs = inputs.timeoutMinutes * 60_000
  const first = made.video.versions.find((x) => x.n === made.n)
  if (inputs.timeoutMinutes === 0) {
    o.saveMarker(o.marker(made.uploaded))
    await surface.show({ kind: 'started', revision: made.n })
    report(ctx, {
      status: 'queued',
      video: made.video,
      ...(first ? { version: first } : {}),
      created: o.created,
      ...(o.prompt ? { prompt: o.prompt } : {}),
    })
    return 'queued'
  }
  o.saveMarker(o.marker(made.uploaded))
  await surface.show({ kind: 'started', revision: made.n })
  const result: Followed = await run.log.group(`Following ${made.video.id} v${made.n}`, () =>
    follow(run, va, made.video.id, made.n, {
      timeoutMs,
      onRunning: async (v) =>
        surface.show({ kind: 'running', revision: made.n, since: v.timings?.startedAt ?? null }),
    }),
  )
  if (result.outcome === 'timeout') {
    // Screenshots stay pending in the marker; the next event cleans them up.
    o.saveMarker(o.marker(made.uploaded))
    await surface.show({ kind: 'still', minutes: inputs.timeoutMinutes, version: result.version })
    report(ctx, {
      status: 'still-making',
      video: result.video,
      ...(result.version ? { version: result.version } : {}),
      created: o.created,
      ...(o.prompt ? { prompt: o.prompt } : {}),
    })
    return 'still-making'
  }
  const left = made.uploaded.length ? await cleanup(run, va, made.uploaded) : []
  o.saveMarker(o.marker(left))
  let video = result.video
  let version = result.version
  if (result.outcome === 'ready') {
    if (inputs.publish) {
      await va.versions.publish(video.id, version.n, {})
      video = await va.videos.get(video.id)
      version = video.versions.find((x) => x.n === version.n) ?? version
    }
    await o.afterReady?.(video, version)
    await surface.show({ kind: 'ready', version })
    report(ctx, {
      status: 'ready',
      video,
      version,
      created: o.created,
      ...(o.prompt ? { prompt: o.prompt } : {}),
    })
    return 'ready'
  }
  await surface.show({ kind: 'failed', version, retriesLeft: version.attempts < MAX_ATTEMPTS })
  const status = failedStatus(version)
  report(ctx, { status, video, version, created: o.created, ...(o.prompt ? { prompt: o.prompt } : {}) })
  return status
}

async function showCap(ctx: Ctx, surface: Surface, b: Exclude<BudgetResult, { ok: true }>) {
  await surface.show(
    b.kind === 'limit'
      ? { kind: 'limit', maxVersions: b.limit }
      : { kind: 'budget', cap: b.cap, used: b.used, limit: b.limit },
  )
  ctx.run.log.decision('stopped', { cap: b.cap, used: b.used, limit: b.limit })
  report(ctx, { status: 'skipped' })
}

function logBrief(run: Run, brief: Brief) {
  const removed = describeRemoved(brief.removed)
  if (removed) run.log.line({ scrub: removed })
  for (const w of brief.warnings) run.log.line({ brief: 'note', note: w })
}

/** dry-run: print the brief and the calls it would make; spend and change nothing. */
function dryRun(ctx: Ctx, brief: Brief, calls: string[]) {
  const { run } = ctx
  logBrief(run, brief)
  run.deps.core.info(`video-agent: dry-run brief (${brief.prompt.length} characters):\n${brief.prompt}`)
  for (const c of calls) run.log.line({ 'would-call': c })
  report(ctx, { status: 'dry-run', prompt: brief.prompt })
}

// ───── pull requests ─────

const prRef = (gh: GitHub, n: number): RefTarget => ({
  kind: 'pr',
  owner: gh.owner,
  repo: gh.repo,
  number: n,
})

/** The PR's comment as a surface, with its marker kept up to date. */
async function prSurface(ctx: Ctx, pr: number) {
  const { run, gh } = ctx
  const me = await identity(gh)
  const own = await findOwnComment(gh, pr, me, run.log)
  let current = own ? { id: own.id, body: own.body } : null
  let marker: Marker | null = own?.marker ?? null
  let webUrl = ''
  const surface: Surface & {
    marker(): Marker | null
    set(m: Marker): void
    commentId(): number | undefined
  } = {
    marker: () => marker,
    set: (m) => {
      marker = m
      webUrl = `${ctx.inputs.url}/videos/${m.videoId}`
    },
    commentId: () => current?.id,
    show: async (state) => {
      if (!marker || ctx.inputs.dryRun) return
      const text = renderComment(state, { marker, webUrl, features: ctx.features })
      current = await upsertComment(gh, pr, current, text)
      setOutputs(run, { 'comment-id': String(current.id) })
    },
  }
  if (marker) surface.set(marker)
  return surface
}

/** The current state of an existing video, for the comment. */
function stateOf(v: Video, inputs: Inputs): { state: CommentState; status: string; version?: Version } {
  const l = latest(v)
  if (!l) return { state: { kind: 'started', revision: 1 }, status: 'queued' }
  if (l.status === 'ready') return { state: { kind: 'ready', version: l }, status: 'ready', version: l }
  if (l.status === 'failed' || l.status === 'cancelled' || l.status === 'timed_out')
    return {
      state: { kind: 'failed', version: l, retriesLeft: l.attempts < MAX_ATTEMPTS },
      status: failedStatus(l),
      version: l,
    }
  if (l.status === 'queued')
    return { state: { kind: 'started', revision: l.n }, status: 'queued', version: l }
  return {
    state: { kind: 'still', minutes: inputs.timeoutMinutes, version: l },
    status: 'still-making',
    version: l,
  }
}

export type PrAction =
  | { kind: 'label' }
  | { kind: 'push' }
  | { kind: 'video' }
  | { kind: 'revise'; change: string; commentId: number }
  | { kind: 'status' }
  | { kind: 'publish' }
  | { kind: 'retry' }
  | { kind: 'cancel' }
  | { kind: 'redo'; scene: string; change: string; commentId: number }

export type Outcome = { status: string; ok: boolean; message?: string }

export async function handlePr(
  ctx: Ctx,
  pr: PrInfo,
  action: PrAction,
  commandId: number | null,
): Promise<Outcome> {
  const { run, inputs, gh, va } = ctx
  const target = prRef(gh, pr.number)
  const surface = await prSurface(ctx, pr.number)
  const marker = surface.marker()
  // Leftover screenshots from a run that stopped waiting.
  if (marker?.pending?.length && !inputs.dryRun) {
    const left = await cleanup(run, va, marker.pending)
    surface.set({ ...marker, pending: left })
  }
  const video = await findVideo(va, target, marker, run.log)
  const markerFor = (videoId: string, pending: string[], made: number) => ({
    videoId,
    headSha: pr.headSha,
    made,
    ...(pending.length ? { pending } : {}),
  })
  const made = (marker?.videoId === video?.id ? marker?.made : undefined) ?? 0
  const showExisting = async (v: Video) => {
    surface.set(markerFor(v.id, surface.marker()?.pending ?? [], made))
    const s = stateOf(v, inputs)
    await surface.show(s.state)
    report(ctx, {
      status: s.status,
      video: v,
      ...(s.version ? { version: s.version } : {}),
      created: false,
      ...(surface.commentId() ? { commentId: surface.commentId() as number } : {}),
    })
    return { status: s.status, ok: true }
  }
  const brief = (captions: string[]) =>
    prBrief({
      owner: gh.owner,
      repo: gh.repo,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      commits: pr.commits,
      files: pr.files,
      filesTotal: pr.filesTotal,
      authorTrusted: pr.authorTrusted,
      extra: inputs.prompt,
      screenshots: captions,
    })
  const createNew = async (key: string) => {
    await run.deps.hook?.('after-lookup')
    const out = await create(ctx, {
      target,
      brief,
      title: prTitle(pr.number, pr.title),
      durationSec: inputs.duration ?? 30,
      key,
      shots: () => shotsFor(ctx, pr),
      surface,
      marker: (id, pending) => markerFor(id, pending, 1),
      remix: {
        label: `PR #${pr.number}: ${pr.title}`,
        changes: () =>
          [
            pr.title,
            pr.authorTrusted ? pr.body : '',
            pr.authorTrusted && pr.commits.length
              ? `Commits: ${pr.commits.map((c) => c.split('\n')[0]).join('; ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
      },
    })
    if (out === 'stopped') return { status: 'skipped', ok: true }
    if (out === 'dry-run') return { status: 'dry-run', ok: true }
    const p = run.outputs.prompt
    const status = await followAndShow(ctx, out, surface, {
      created: true,
      ...(p ? { prompt: p } : {}),
      marker: (pending) => markerFor(out.video.id, pending, out.n === 1 ? 1 : made),
      saveMarker: (m) => surface.set(m),
    })
    return { status, ok: true }
  }

  switch (action.kind) {
    case 'label':
    case 'video': {
      if (video) {
        run.log.decision('existing', { video: video.id, reason: 'this PR already has a video; no new spend' })
        return showExisting(video)
      }
      const key =
        action.kind === 'video' && commandId !== null
          ? keys.command(target, commandId)
          : keys.create(target, run.ctx.runId)
      run.log.decision('create', { reason: action.kind === 'label' ? 'label' : 'command', pr: pr.number })
      return createNew(key)
    }
    case 'status': {
      if (!video)
        return { status: 'none', ok: false, message: 'no video for this PR yet: reply /video to make one' }
      return showExisting(video)
    }
    case 'redo': {
      if (!video)
        return { status: 'none', ok: false, message: 'no video for this PR yet: reply /video to make one' }
      if (!ctx.features.includes('scoped_revision'))
        return { status: 'none', ok: false, message: 'redoing one scene is not available on this server' }
      if (!action.change.trim())
        return {
          status: 'none',
          ok: false,
          message: 'say what to change: /video redo <scene> <what to change>',
        }
      return revise(ctx, video, surface, {
        made,
        scene: action.scene,
        prompt: () =>
          reviseBrief({
            target,
            change: action.change,
            context: { title: pr.title, files: pr.files },
            authorTrusted: pr.authorTrusted,
          }),
        key: keys.command(target, action.commentId),
        markerFor,
      })
    }
    case 'push':
    case 'revise': {
      if (!video) {
        if (action.kind === 'revise')
          return { status: 'none', ok: false, message: 'no video for this PR yet: reply /video to make one' }
        // The label makes the first video; new commits only update one.
        run.log.decision('none', { reason: 'no video yet', pr: pr.number })
        return { status: 'skipped', ok: true }
      }
      if (action.kind === 'push' && marker?.headSha === pr.headSha) {
        run.log.decision('none', { reason: 'no new commits since the last version', pr: pr.number })
        return showExisting(video)
      }
      if (action.kind === 'revise' && !action.change.trim())
        return { status: 'none', ok: false, message: 'say what to change: /video revise <what to change>' }
      const since =
        action.kind === 'push' && marker?.headSha ? await sinceLast(ctx, marker.headSha, pr) : null
      return revise(ctx, video, surface, {
        made,
        prompt: () =>
          action.kind === 'revise'
            ? reviseBrief({
                target,
                change: action.change,
                context: { title: pr.title, files: pr.files },
                authorTrusted: pr.authorTrusted,
              })
            : reviseBrief({
                target,
                context: { title: pr.title, files: pr.files },
                ...(since ?? { sinceCommits: pr.commits, sinceFiles: pr.files }),
                authorTrusted: pr.authorTrusted,
              }),
        key:
          action.kind === 'revise'
            ? keys.command(target, action.commentId)
            : keys.revise(target, pr.headSha, run.ctx.runId),
        markerFor,
      })
    }
    case 'publish': {
      if (!video) return { status: 'none', ok: false, message: 'no video for this PR yet' }
      if (video.private)
        return {
          status: 'refused',
          ok: false,
          message: 'this video is private; publish it from the app if you mean to',
        }
      const ready = latestReady(video)
      if (!ready) return { status: 'none', ok: false, message: 'nothing ready to publish yet' }
      if (inputs.dryRun) {
        run.log.line({ 'would-call': `POST /api/v1/videos/${video.id}/versions/${ready.n}/publish` })
        return { status: 'dry-run', ok: true }
      }
      await va.versions.publish(video.id, ready.n, {})
      return showExisting(await va.videos.get(video.id))
    }
    case 'retry': {
      if (!video) return { status: 'none', ok: false, message: 'no video for this PR yet' }
      const l = latest(video)
      if (!l || !['failed', 'cancelled', 'timed_out'].includes(l.status))
        return { status: 'none', ok: false, message: 'the latest version did not fail; nothing to retry' }
      if (l.attempts >= MAX_ATTEMPTS)
        return { status: 'refused', ok: false, message: 'no retries left for this version' }
      const budget = await checkBudget(run, va, inputs, { video, newVersion: false })
      if (!budget.ok && !inputs.dryRun) {
        await showCap(ctx, surface, budget)
        return { status: 'skipped', ok: false, message: `${budget.cap} reached` }
      }
      if (inputs.dryRun) {
        run.log.line({ 'would-call': `POST /api/v1/videos/${video.id}/versions/${l.n}/retry` })
        return { status: 'dry-run', ok: true }
      }
      await va.versions.retry(video.id, l.n)
      const again = await va.videos.get(video.id)
      const status = await followAndShow(ctx, { video: again, n: l.n, uploaded: [] }, surface, {
        created: true,
        marker: (pending) => markerFor(video.id, pending, made),
        saveMarker: (m) => surface.set(m),
      })
      return { status, ok: true }
    }
    case 'cancel': {
      if (!video) return { status: 'none', ok: false, message: 'no video for this PR yet' }
      const l = latest(video)
      if (!l || !['queued', 'running', 'finishing'].includes(l.status))
        return { status: 'none', ok: false, message: 'nothing to cancel' }
      if (inputs.dryRun) return { status: 'dry-run', ok: true }
      await va.versions.cancel(video.id, l.n)
      return showExisting(await va.videos.get(video.id))
    }
  }
}

/** A new version from the latest ready one; a version in progress is waited for first (one at a time). */
async function revise(
  ctx: Ctx,
  video: Video,
  surface: Awaited<ReturnType<typeof prSurface>>,
  o: {
    made: number
    prompt: () => Brief
    key: string
    markerFor: (id: string, pending: string[], made: number) => Marker
    /** /video redo: only this scene (an id or a unique label of the version it starts from). */
    scene?: string
  },
): Promise<Outcome> {
  const { run, inputs, va } = ctx
  let current = video
  const busy = latest(current)
  if (busy && ['queued', 'running', 'finishing'].includes(busy.status)) {
    run.log.decision('wait', { reason: 'a version is in progress', video: current.id, version: busy.n })
    const done = await follow(run, va, current.id, busy.n, { timeoutMs: inputs.timeoutMinutes * 60_000 })
    if (done.outcome === 'timeout') {
      await surface.show({ kind: 'still', minutes: inputs.timeoutMinutes, version: done.version })
      report(ctx, {
        status: 'still-making',
        video: done.video,
        ...(done.version ? { version: done.version } : {}),
        created: false,
      })
      return { status: 'still-making', ok: true }
    }
    current = done.video
  }
  const from = latestReady(current)
  if (!from)
    return {
      status: 'none',
      ok: false,
      message: 'no ready version to revise yet: reply /video retry or /video status',
    }
  let beats: string[] | undefined
  if (o.scene !== undefined) {
    const scene = resolveScene(from, o.scene)
    if ('error' in scene) return { status: 'none', ok: false, message: scene.error }
    beats = [scene.id]
    run.log.decision('redo', { scene: scene.id, version: from.n })
  }
  const budget = await checkBudget(run, va, inputs, { video: current, newVersion: true })
  if (!budget.ok && !inputs.dryRun) {
    await showCap(ctx, surface, budget)
    return { status: 'skipped', ok: false, message: `${budget.cap} reached` }
  }
  const brief = o.prompt()
  if (inputs.dryRun) {
    dryRun(ctx, brief, [
      `POST /api/v1/videos/${current.id}/versions (prompt ${brief.prompt.length} characters, fromVersion ${from.n}${beats ? `, scope ${beats.join(',')}` : ''}, Idempotency-Key ${o.key})`,
    ])
    return { status: 'dry-run', ok: true }
  }
  logBrief(run, brief)
  const res = beats
    ? await va.videos.redoScenes(
        current.id,
        { beats, prompt: brief.prompt, fromVersion: from.n },
        { idempotencyKey: o.key },
      )
    : await va.videos.revise(
        current.id,
        { prompt: brief.prompt, fromVersion: from.n },
        { idempotencyKey: o.key },
      )
  const after = await va.videos.get(res.id)
  run.log.decision('revised', { video: after.id, version: after.latestVersion, key: o.key })
  setOutputs(run, { prompt: brief.prompt })
  const status = await followAndShow(ctx, { video: after, n: after.latestVersion, uploaded: [] }, surface, {
    created: true,
    prompt: brief.prompt,
    marker: (pending) => o.markerFor(after.id, pending, o.made + 1),
    saveMarker: (m) => surface.set(m),
  })
  return { status, ok: true }
}

/**
 * What changed since the version's head (bead va-mg4i.3.1): the compare API's commits and files from the marker's
 * headSha to the PR's head; null (use the whole PR) when that isn't a simple fast-forward, e.g. after a force-push.
 */
async function sinceLast(ctx: Ctx, from: string, pr: PrInfo) {
  try {
    const res = await ctx.gh.request<{
      status: string
      commits: { commit: { message: string } }[]
      files?: { filename: string }[]
    }>('GET /repos/{owner}/{repo}/compare/{basehead}', { path: { basehead: `${from}...${pr.headSha}` } })
    if (res.data.status !== 'ahead') return null
    return {
      sinceCommits: res.data.commits.map((c) => c.commit.message),
      sinceFiles: (res.data.files ?? []).map((f) => f.filename),
    }
  } catch {
    return null
  }
}

/** A scene of a version by id, or by a label that matches exactly one scene (case-insensitive). */
export function resolveScene(v: Version, scene: string): { id: string } | { error: string } {
  const beats = v.beats ?? []
  const list = beats.map((b) => (b.label ? `${b.id} ("${b.label}")` : b.id)).join(', ')
  if (!beats.length) return { error: `v${v.n} has no scenes to redo (it isn't an editable composition)` }
  const byId = beats.find((b) => b.id === scene)
  if (byId) return { id: byId.id }
  const byLabel = beats.filter((b) => (b.label ?? '').toLowerCase() === scene.toLowerCase())
  if (byLabel.length === 1 && byLabel[0]) return { id: byLabel[0].id }
  return {
    error: `${byLabel.length > 1 ? `more than one scene is called "${scene}"` : `no scene "${scene}"`} in v${v.n}; scenes: ${list}`,
  }
}

async function shotsFor(ctx: Ctx, pr: PrInfo): Promise<Shot[]> {
  const s = ctx.inputs.screenshots
  if (s.kind === 'none') return []
  if (s.kind === 'glob') return fromGlob(ctx.run, s.pattern)
  if (!pr.authorTrusted) {
    ctx.run.log.line({ screenshot: 'skipped', reason: 'the PR author is not trusted' })
    return []
  }
  return fromBody(ctx.run, ctx.gh, pr.number, pr.body)
}

// ───── releases ─────

interface ReleaseInfo {
  id: number
  tag: string
  name: string | null
  body: string
  url: string
  /** Where assets go (the release's upload_url without its {?name,label} template). */
  uploadUrl: string
}

export async function handleRelease(ctx: Ctx, release: ReleaseInfo): Promise<Outcome> {
  const { run, inputs, gh, va } = ctx
  const target: RefTarget = { kind: 'release', owner: gh.owner, repo: gh.repo, tag: release.tag }
  const section = readSection(release.body)
  let marker: Marker | null = section ? parseMarker(section, run.log) : null
  let body = release.body
  const surface: Surface = {
    show: async (state) => {
      if (!marker || inputs.dryRun) return
      const next = withSection(body, renderSection(state, marker, `${inputs.url}/videos/${marker.videoId}`))
      if (next === body) return
      await gh.request('PATCH /repos/{owner}/{repo}/releases/{release_id}', {
        path: { release_id: release.id },
        body: { body: next },
      })
      body = next
    },
  }
  if (marker?.pending?.length && !inputs.dryRun)
    marker = { ...marker, pending: await cleanup(run, va, marker.pending) }
  const video = await findVideo(va, target, marker, run.log)
  if (video) {
    marker = {
      videoId: video.id,
      made: marker?.made ?? 0,
      ...(marker?.pending?.length ? { pending: marker.pending } : {}),
    }
    const s = stateOf(video, inputs)
    // A re-run replaces the assets (same names) rather than failing on the clash.
    if (s.version?.status === 'ready' && inputs.releaseAsset && !inputs.dryRun)
      await attachAssets(ctx, release, video, s.version)
    await surface.show(s.state)
    run.log.decision('existing', {
      video: video.id,
      reason: 'this release already has a video; no new spend',
    })
    report(ctx, { status: s.status, video, ...(s.version ? { version: s.version } : {}), created: false })
    return { status: s.status, ok: true }
  }
  run.log.decision('create', { reason: 'release', tag: release.tag })
  const out = await create(ctx, {
    target,
    brief: () =>
      releaseBrief({
        owner: gh.owner,
        repo: gh.repo,
        tag: release.tag,
        name: release.name,
        body: release.body,
        extra: inputs.prompt,
      }),
    title: releaseTitle(gh.repo, release.tag),
    durationSec: inputs.duration ?? 45,
    key: keys.create(target, run.ctx.runId),
    shots: async () => (inputs.screenshots.kind === 'glob' ? fromGlob(run, inputs.screenshots.pattern) : []),
    surface,
    marker: (id, pending) => ({ videoId: id, made: 1, ...(pending.length ? { pending } : {}) }),
    remix: { label: `release ${release.tag}`, changes: () => release.body || release.tag },
  })
  if (out === 'stopped') return { status: 'skipped', ok: true }
  if (out === 'dry-run') return { status: 'dry-run', ok: true }
  const p = run.outputs.prompt
  const status = await followAndShow(ctx, out, surface, {
    created: true,
    ...(p ? { prompt: p } : {}),
    marker: (pending) => ({ videoId: out.video.id, made: 1, ...(pending.length ? { pending } : {}) }),
    saveMarker: (m) => {
      marker = m
    },
    ...(inputs.releaseAsset
      ? { afterReady: (v: Video, x: Version) => attachAssets(ctx, release, v, x) }
      : {}),
  })
  return { status, ok: true }
}

/**
 * release-asset (bead va-mg4i.3.3): the version's MP4 and captions attached to the release as video-<tag>.mp4 and
 * video-<tag>.vtt. Downloads follow the file routes' signed redirects without the key. A re-run replaces assets of the
 * same name instead of failing on the clash.
 */
async function attachAssets(ctx: Ctx, release: ReleaseInfo, video: Video, version: Version) {
  const { run, gh, va } = ctx
  const dir = await mkdtemp(join(tmpdir(), 'video-agent-assets-'))
  try {
    const existing: { id: number; name: string }[] = []
    for await (const a of gh.paginate<{ id: number; name: string }>(
      'GET /repos/{owner}/{repo}/releases/{release_id}/assets',
      { path: { release_id: release.id } },
    ))
      existing.push(a)
    const files = [
      { file: 'video' as const, name: `video-${release.tag}.mp4`, type: 'video/mp4' },
      { file: 'captions' as const, name: `video-${release.tag}.vtt`, type: 'text/vtt' },
    ]
    for (const f of files) {
      const to = join(dir, f.name)
      await va.files.download(video, { file: f.file, version: version.n, to })
      const bytes = new Uint8Array(await readFile(to))
      for (const old of existing.filter((a) => a.name === f.name))
        await gh.request('DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}', {
          path: { asset_id: old.id },
        })
      await gh.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
        url: `${release.uploadUrl}?name=${encodeURIComponent(f.name)}`,
        raw: { bytes, contentType: f.type },
      })
      run.log.line({ release: 'asset', name: f.name, bytes: bytes.byteLength })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ───── one-off videos ─────

export async function handleDispatch(ctx: Ctx): Promise<Outcome> {
  const { run, inputs, gh } = ctx
  const none: Surface = { show: async () => undefined }
  const brief = dispatchBrief({ prompt: inputs.prompt })
  const out = await create(ctx, {
    target: null,
    brief: () => brief,
    title: undefined,
    durationSec: inputs.duration ?? 30,
    key: keys.dispatch(gh.owner, gh.repo, run.ctx.runId),
    shots: async () => (inputs.screenshots.kind === 'glob' ? fromGlob(run, inputs.screenshots.pattern) : []),
    surface: none,
    marker: (id) => ({ videoId: id }),
  })
  if (out === 'stopped') return { status: 'skipped', ok: true }
  if (out === 'dry-run') return { status: 'dry-run', ok: true }
  const status = await followAndShow(ctx, out, none, {
    created: true,
    prompt: brief.prompt,
    marker: (pending) => ({ videoId: out.video.id, ...(pending.length ? { pending } : {}) }),
    saveMarker: () => undefined,
  })
  return { status, ok: true }
}

export { isVideoAgentError }
