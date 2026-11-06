// Phase-1 live gate for recorded voice-over: take privacy and GC (plan 2026-11-02 §8, §9 phase 1; bead va-2qq.2.11).
// Spends no credits: it renders nothing.
//
//   npx tsx scripts/e2e/narration-privacy.ts --dry      # checks the env and prints the steps; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… VIDEO_AGENT_KEY_B=nva_… VIDEO_AGENT_KEY_R=nva_… \
//     [VIDEO_ID=vid_…] [GC_WAIT_MIN=5] [ALLOW_DELETE_UNUSED=1] npx tsx scripts/e2e/narration-privacy.ts
//
// Keys: VIDEO_AGENT_KEY is Creator A (owns the test video), VIDEO_AGENT_KEY_B is Creator B (a Creator, not an admin:
// admins read every take), VIDEO_AGENT_KEY_R is a Reviewer. Without VIDEO_AGENT_KEY_R, B also plays the Reviewer: A (who
// must then be an admin) switches B's role to Reviewer for each Reviewer check and back to Creator after, and the
// cleanup always puts B back to Creator. VIDEO_ID is a ready, editable video A owns (default: A's
// newest ready one with an editable version). A private video is made visible for the run (B must be able to see it)
// and put back at the end.
//
// Steps: A uploads two 2-second takes (upload sessions, role narration-take, scopeJobId = the video) with peaks and
// speech spans. While unused, B and R get 404 on each take through GET /media/:id, /peaks and /speech, and it's
// missing from their library search, the video's recordings list, the duplicate check (POST /media/check) and MCP
// list_media (A finds it on every one of those paths, so the 404s aren't vacuous). A opens a draft, takes the
// narration lock and saves a narration op placing both: now B reads both, R still gets 404 everywhere. A discards the
// draft (references released: B gets 404 again), opens a second draft that keeps only take 2, and saves it again
// while "Delete unused recordings" runs at the same moment (a concurrent save and GC). Take 1 must go (404 to A, and
// its signed file links 404 once the bytes are deleted, polled for up to GC_WAIT_MIN minutes); take 2 must stay,
// bytes intact. Then scripts/e2e/headers.ts runs (the microphone Permissions-Policy, plan §8).
//
// "Delete unused recordings" deletes every unused recording A has, not only this script's. So the script stops
// before uploading anything if A has other unused recordings, unless ALLOW_DELETE_UNUSED=1 says they may go.
// It refuses to reuse a draft of A's that already has edits.
//
// Cleanup, also on failure: drafts discarded, the narration lock released, the video's privacy restored, the
// takes deleted from the library and (when allowed, as above) their bytes deleted with "Delete unused recordings".
// Logs JSON lines, one per step and check; ends with PASS or FAIL and a summary; exits non-zero on failure.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SAMPLE_RATE } from '../../src/lib/timeline.js'
import { base, key, log, started } from './lib.js'
import {
  call,
  check,
  dry,
  dryRun,
  encodeWav,
  finish,
  GateError,
  mcpTool,
  mcpTools,
  narrationOp,
  openDraft,
  saveDraft,
  sha256,
  sleep,
  uploadRecording,
  type Edit,
  type Media,
} from './narration-lib.js'

const keyB = process.env.VIDEO_AGENT_KEY_B ?? ''
// One second account is enough: without a Reviewer key, B is switched to Reviewer (by admin A) for R's checks.
const flip = !process.env.VIDEO_AGENT_KEY_R
const keyR = process.env.VIDEO_AGENT_KEY_R || keyB
const videoIdEnv = process.env.VIDEO_ID ?? ''
const gcWaitMin = Number(process.env.GC_WAIT_MIN ?? 5)
const allowDeleteUnused = process.env.ALLOW_DELETE_UNUSED === '1'
const run = `np${Date.now().toString(36)}`

const STEPS = [
  'preflight: roles of A, B and R (/api/v1/me); the video (VIDEO_ID or A’s newest ready editable one); A’s other unused recordings (stop unless ALLOW_DELETE_UNUSED=1)',
  'make the video visible for B if it is private (restored at the end)',
  `upload take 1 and take 2 as A (upload sessions, role narration-take, scopeJobId), then peaks + speech spans`,
  'A (control): reads each take, its peaks and speech; finds it in search, the recordings list, the duplicate check and MCP list_media',
  'unused: B and R get 404 on media/peaks/speech and see neither take in search, recordings, duplicate check, MCP list_media',
  'A opens a draft, takes the narration lock, saves a narration op placing both takes',
  'used: B reads both takes (media, peaks, speech, recordings list); R still 404 everywhere',
  'A discards the draft: references released; B gets 404 again',
  'A opens a second draft keeping only take 2; saves it again concurrently with POST /media/recordings/delete-unused',
  `take 1: 404 for A; its signed file links 404 once the bytes are deleted (polled up to GC_WAIT_MIN=${gcWaitMin} min)`,
  'take 2: still ready for A, bytes intact (sha256), still readable by B',
  'scripts/e2e/headers.ts (microphone Permissions-Policy), spawned with the same env',
  'cleanup: discard drafts, release the lock, restore privacy, delete the takes (bytes too when allowed)',
]

if (dry)
  dryRun({
    script: 'narration-privacy',
    required: {
      VIDEO_AGENT_URL: process.env.VIDEO_AGENT_URL,
      VIDEO_AGENT_KEY: process.env.VIDEO_AGENT_KEY,
      VIDEO_AGENT_KEY_B: process.env.VIDEO_AGENT_KEY_B,
    },
    optional: {
      VIDEO_AGENT_KEY_R: process.env.VIDEO_AGENT_KEY_R, // unset: B is switched to Reviewer by admin A
      VIDEO_ID: process.env.VIDEO_ID,
      GC_WAIT_MIN: process.env.GC_WAIT_MIN,
      ALLOW_DELETE_UNUSED: process.env.ALLOW_DELETE_UNUSED,
    },
    steps: STEPS,
    credits: { projected: 0, renders: 0, note: 'phase 1 renders nothing' },
    problems: Number.isFinite(gcWaitMin) && gcWaitMin > 0 ? [] : ['GC_WAIT_MIN must be a positive number'],
  })
if (!base || !key || !keyB)
  throw new Error(
    'Set VIDEO_AGENT_URL, VIDEO_AGENT_KEY and VIDEO_AGENT_KEY_B, and VIDEO_AGENT_KEY_R or an admin A (or pass --dry).',
  )

interface Me {
  id: string
  role: string
}

/** B's user id, for switching it to Reviewer and back (flip mode). */
let bUserId = ''
let bIsReviewer = false
async function setB(role: 'reviewer' | 'creator') {
  if (!flip || (role === 'reviewer') === bIsReviewer) return
  const r = await call(key, 'PATCH', `/api/v1/users/${bUserId}`, { role })
  check(r.status === 200, `switch B to ${role}`, { status: r.status, body: r.json })
  bIsReviewer = role === 'reviewer'
  log('role_switch', { user: bUserId, role })
}
/** Runs `f` with R's key acting as a Reviewer: B switched to Reviewer for it in flip mode. */
async function asR<T>(f: () => Promise<T>): Promise<T> {
  await setB('reviewer')
  try {
    return await f()
  } finally {
    await setB('creator')
  }
}
interface Video {
  id: string
  private: boolean
  owner: { id: string }
  versions: { n: number; status: string; editable: boolean }[]
}

const passed: string[] = []
const created = { takes: [] as string[], drafts: [] as string[] }
let videoId = ''
let restorePrivate: boolean | null = null
let lockHeld = false as boolean

const ok = (name: string, f: Record<string, unknown> = {}) => {
  passed.push(name)
  log('ok', { check: name, ...f })
}

/** Every path a take can be exposed on, as `k`: whether each one shows it. */
async function exposure(k: string, take: Media, who: string) {
  const media = await call(k, 'GET', `/api/v1/media/${take.id}`)
  const peaks = await call(k, 'GET', `/api/v1/media/${take.id}/peaks`)
  const speech = await call(k, 'GET', `/api/v1/media/${take.id}/speech`)
  const search = await call<{ items?: { id: string }[] }>(
    k,
    'GET',
    `/api/v1/media?q=${encodeURIComponent(run)}&recordings=include&limit=100`,
  )
  const recordings = await call<{ items?: { id: string }[] }>(
    k,
    'GET',
    `/api/v1/videos/${videoId}/recordings`,
  )
  const dup = await call<{ files?: { sameFile: { id: string } | null; sameName: { id: string } | null }[] }>(
    k,
    'POST',
    '/api/v1/media/check',
    { files: [{ filename: take.filename, sha256: takeSha.get(take.id) ?? '' }] },
  )
  const f = dup.json.files?.[0]
  let mcp: boolean | 'skipped' = 'skipped'
  if (mcpHas.get(k)) {
    const r = await mcpTool(k, 'list_media', { query: run, kind: 'audio' })
    const list = (r.structured.media as { id: string }[] | undefined) ?? []
    mcp = list.some((m) => m.id === take.id)
  }
  const seen = {
    media: media.status === 200,
    peaks: peaks.status === 200,
    speech: speech.status === 200,
    search: search.status === 200 && !!search.json.items?.some((m) => m.id === take.id),
    recordings: recordings.status === 200 && !!recordings.json.items?.some((m) => m.id === take.id),
    duplicate: f?.sameFile?.id === take.id || f?.sameName?.id === take.id,
    mcp,
  }
  log('exposure', {
    who,
    mediaId: take.id,
    statuses: { media: media.status, peaks: peaks.status, speech: speech.status, search: search.status },
    recordingsStatus: recordings.status,
    checkStatus: dup.status,
    seen,
  })
  return { seen, statuses: { media: media.status, peaks: peaks.status, speech: speech.status } }
}
const takeSha = new Map<string, string>()
const mcpHas = new Map<string, boolean>()

async function expectHidden(k: string, who: string, take: Media, label: string) {
  const { seen, statuses } = await exposure(k, take, who)
  const leaks = Object.entries(seen).filter(([, v]) => v === true)
  check(!leaks.length, `${label}: ${who} must not see ${take.id}`, { leaks: leaks.map(([p]) => p), seen })
  check(
    statuses.media === 404 && statuses.peaks === 404 && statuses.speech === 404,
    `${label}: ${who} should get 404 (not 403) on the take, its peaks and speech`,
    statuses,
  )
  ok(`${label}: hidden from ${who}`, { mediaId: take.id, mcp: seen.mcp })
}
async function expectReadable(k: string, who: string, take: Media, label: string, paths: (keyof Seen)[]) {
  const { seen } = await exposure(k, take, who)
  const missing = paths.filter((p) => seen[p] !== true && seen[p] !== 'skipped')
  check(!missing.length, `${label}: ${who} should read ${take.id}`, { missing, seen })
  ok(`${label}: readable by ${who}`, { mediaId: take.id, paths })
}
type Seen = Awaited<ReturnType<typeof exposure>>['seen']

/** A 2-second take: a 440 Hz tone with a short pause, plus run-unique noise so its sha256 is new. */
function takeWav(seed: number) {
  const n = 2 * SAMPLE_RATE
  const pcm = new Float32Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31
    const tone =
      i > 0.2 * SAMPLE_RATE && i < 1.7 * SAMPLE_RATE
        ? 0.3 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)
        : 0
    pcm[i] = tone + (x / 2 ** 31 - 0.5) * 0.002
  }
  return encodeWav(pcm)
}

async function draft(n: number) {
  const d = await openDraft(key, videoId, n, (id) => created.drafts.push(id))
  lockHeld = true
  return d
}
const save = (d: Edit, rev: number, ops: unknown[]) => saveDraft(key, d, rev, ops)

/** A's unused recordings that this run didn't make (delete-unused would delete them too). */
async function othersUnused() {
  const out: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    const r = await call<{ items: Media[]; nextCursor: string | null }>(
      key,
      'GET',
      `/api/v1/media?recordings=only&limit=100${q}`,
    )
    check(r.status === 200, 'list A’s recordings', { status: r.status })
    for (const m of r.json.items)
      if (m.recording && m.recording.retainUntil !== null && !created.takes.includes(m.id)) out.push(m.id)
    cursor = r.json.nextCursor
    if (!cursor) break
  }
  return out
}

let failure: GateError | Error | null = null
try {
  // ── preflight ──
  const [meA, meB] = await Promise.all(
    [key, keyB].map(async (k) => (await call<Me>(k, 'GET', '/api/v1/me')).json),
  )
  bUserId = meB?.id ?? ''
  if (flip)
    check(meA?.role === 'admin', 'Without VIDEO_AGENT_KEY_R, A must be an admin (to switch B to Reviewer)', {
      role: meA?.role,
    })
  const meR = await asR(async () => (await call<Me>(keyR, 'GET', '/api/v1/me')).json)
  log('principals', { a: meA?.role, b: meB?.role, r: meR.role })
  check(meA?.role === 'creator' || meA?.role === 'admin', 'VIDEO_AGENT_KEY must be a Creator (or admin)', {
    role: meA?.role,
  })
  check(
    meB?.role === 'creator',
    'VIDEO_AGENT_KEY_B must be a Creator, not an admin (admins read every take)',
    {
      role: meB?.role,
    },
  )
  check(meR.role === 'reviewer', 'VIDEO_AGENT_KEY_R must be a Reviewer', { role: meR.role })
  check(
    meA.id !== meB.id && meA.id !== meR.id && (flip || meB.id !== meR.id),
    flip ? 'A and B must be two different people' : 'A, B and R must be three different people',
  )

  let video: Video | undefined
  if (videoIdEnv) video = (await call<Video>(key, 'GET', `/api/v1/videos/${videoIdEnv}`)).json
  else {
    const list = await call<{ items: Video[] }>(key, 'GET', '/api/v1/videos?owner=me&status=ready&limit=20')
    video = list.json.items.find((v) => v.versions.some((x) => x.editable))
  }
  check(!!video?.id, 'No ready video owned by A to test with (set VIDEO_ID)', { videoId: videoIdEnv || null })
  videoId = video.id
  check(video.owner.id === meA.id, 'The video must be owned by A', { owner: video.owner.id })
  const n = video.versions.find((x) => x.editable)?.n
  check(n !== undefined, 'The video has no editable version', { videoId })
  log('video', { videoId, n, private: video.private })

  for (const k of [key, keyB]) mcpHas.set(k, (await mcpTools(k)).includes('list_media'))
  const rHasListMedia = await asR(async () => (await mcpTools(keyR)).includes('list_media'))
  if (!flip) mcpHas.set(keyR, rHasListMedia)
  log('mcp', {
    listMedia: { a: mcpHas.get(key), b: mcpHas.get(keyB), r: mcpHas.get(keyR) },
    note: 'a key without list_media skips the MCP path for that key (logged as skipped)',
  })

  const foreign = await othersUnused()
  log('unused_recordings', { others: foreign.length, allowDeleteUnused })
  check(
    !foreign.length || allowDeleteUnused,
    `A has ${foreign.length} other unused recordings that "Delete unused recordings" would delete; set ALLOW_DELETE_UNUSED=1 to let them go, or use another key`,
    { mediaIds: foreign.slice(0, 20) },
  )

  if (video.private) {
    const r = await call(key, 'PATCH', `/api/v1/videos/${videoId}`, { private: false })
    check(r.status === 200, 'make the video visible for the run', { status: r.status })
    restorePrivate = true
    log('privacy', { private: false, restoreTo: true })
  }

  // ── takes ──
  const wav1 = takeWav(Date.now() % 1000003)
  const wav2 = takeWav((Date.now() + 7) % 1000003)
  const take1 = await uploadRecording(key, wav1, {
    filename: `e2e-${run}-take1.wav`,
    role: 'narration-take',
    scopeJobId: videoId,
    step: 'take1',
  })
  created.takes.push(take1.id)
  takeSha.set(take1.id, sha256(wav1))
  const take2 = await uploadRecording(key, wav2, {
    filename: `e2e-${run}-take2.wav`,
    role: 'narration-take',
    scopeJobId: videoId,
    step: 'take2',
  })
  created.takes.push(take2.id)
  takeSha.set(take2.id, sha256(wav2))

  // ── unused: uploader only ──
  for (const t of [take1, take2])
    await expectReadable(key, 'A', t, 'control', [
      'media',
      'peaks',
      'speech',
      'search',
      'recordings',
      'duplicate',
      'mcp',
    ])
  for (const t of [take1, take2]) {
    await expectHidden(keyB, 'B', t, 'unused')
    await asR(() => expectHidden(keyR, 'R', t, 'unused'))
  }

  // ── used by A's draft: Creators who can see the video read it; Reviewers never ──
  const d1 = await draft(n)
  const S = SAMPLE_RATE
  const len = 2 * S
  const at = (sec: number) =>
    Math.min(Math.round(sec * S), Math.max(0, Math.round((d1.composition.duration - 2.1) * S)))
  const both = narrationOp([
    { id: 'c1', mediaId: take1.id, srcStart: 0, srcEnd: len, start: at(0.5) },
    { id: 'c2', mediaId: take2.id, srcStart: 0, srcEnd: len, start: at(0.5) + len + S / 10 },
  ])
  const s1 = await save(d1, d1.rev, [both])
  check(s1.status === 200, 'save a draft that places both takes', { status: s1.status, body: s1.json })
  ok('draft saved with both takes', { draftId: d1.id, rev: s1.json.rev })
  for (const t of [take1, take2]) {
    await expectReadable(keyB, 'B', t, 'used', ['media', 'peaks', 'speech', 'recordings'])
    await asR(() => expectHidden(keyR, 'R', t, 'used'))
  }

  // ── discard: references released ──
  const del = await call(key, 'DELETE', `/api/v1/edits/${d1.id}`)
  check(del.status === 204, 'discard the draft', { status: del.status })
  created.drafts = created.drafts.filter((x) => x !== d1.id)
  ok('draft discarded', { draftId: d1.id })
  await expectHidden(keyB, 'B', take1, 'released')

  // ── concurrent save + GC ──
  const d2 = await draft(n)
  const only2 = narrationOp([{ id: 'c2', mediaId: take2.id, srcStart: 0, srcEnd: len, start: at(0.5) }])
  const s2 = await save(d2, d2.rev, [only2])
  check(s2.status === 200, 'save a draft that keeps take 2', { status: s2.status, body: s2.json })
  const fresh1 = (await call<Media>(key, 'GET', `/api/v1/media/${take1.id}`)).json
  const links1 = [fresh1.urls?.file, fresh1.urls?.original].filter((u): u is string => !!u)
  check(links1.length > 0, 'take 1 should have signed links before GC', { media: fresh1 })
  const t0 = Date.now()
  const [s3, gc] = await Promise.all([
    save(d2, s2.json.rev, [only2]),
    call<{ deleted: number }>(key, 'POST', '/api/v1/media/recordings/delete-unused'),
  ])
  log('concurrent', { save: s3.status, gc: gc.status, deleted: gc.json.deleted, ms: Date.now() - t0 })
  check(s3.status === 200, 'the save racing GC should succeed (take 2 is referenced)', {
    status: s3.status,
    body: s3.json,
  })
  check(gc.status === 200 && gc.json.deleted >= 1, 'delete-unused should delete take 1', {
    status: gc.status,
    body: gc.json,
  })

  const gone = await call(key, 'GET', `/api/v1/media/${take1.id}`)
  check(gone.status === 404, 'take 1 should be 404 to A once deleted', { status: gone.status })
  const deadline = Date.now() + gcWaitMin * 60_000
  let statuses: number[] = []
  for (;;) {
    statuses = await Promise.all(
      links1.map(async (u) => {
        const r = await fetch(`${base}${u}`, { method: 'GET' })
        await r.body?.cancel()
        return r.status
      }),
    )
    if (statuses.every((s) => s === 404) || Date.now() > deadline) break
    if (statuses.some((s) => s === 403)) break
    await sleep(10_000)
  }
  log('take1_bytes', { statuses, waitedSec: Math.round((Date.now() - t0) / 1000) })
  check(
    statuses.every((s) => s === 404),
    statuses.some((s) => s === 403)
      ? 'take 1 links expired before its bytes were seen deleted (inconclusive); raise nothing, rerun'
      : `take 1 bytes still served after ${gcWaitMin} min`,
    { statuses },
  )
  ok('take 1 bytes deleted', { mediaId: take1.id })
  const recA = await call<{ items: { id: string }[] }>(key, 'GET', `/api/v1/videos/${videoId}/recordings`)
  check(!recA.json.items.some((m) => m.id === take1.id), 'take 1 should leave the recordings list')

  const kept = await call<Media>(key, 'GET', `/api/v1/media/${take2.id}`)
  check(kept.status === 200 && kept.json.status === 'ready', 'take 2 (referenced) must survive GC', {
    status: kept.status,
    media: kept.json,
  })
  const orig = await fetch(`${base}${kept.json.urls?.original ?? ''}`)
  const bytes = new Uint8Array(await orig.arrayBuffer())
  check(orig.status === 200 && sha256(bytes) === takeSha.get(take2.id), 'take 2 bytes must be intact', {
    status: orig.status,
    bytes: bytes.byteLength,
  })
  ok('take 2 survives concurrent save + GC', { mediaId: take2.id })
  await expectReadable(keyB, 'B', take2, 'still used', ['media', 'peaks', 'speech'])

  // ── headers.ts ──
  const headers = spawnSync(
    process.execPath,
    [...process.execArgv, fileURLToPath(new URL('./headers.ts', import.meta.url))],
    { stdio: 'inherit', env: { ...process.env, VIDEO_AGENT_KEY: key, VIDEO_ID: videoId } },
  )
  check(headers.status === 0, 'scripts/e2e/headers.ts failed (its lines above say which check)', {
    exit: headers.status,
  })
  ok('microphone Permissions-Policy (headers.ts)')
} catch (e) {
  failure = e instanceof Error ? e : new Error(String(e))
} finally {
  // ── cleanup ──
  const left: Record<string, unknown> = {}
  try {
    // setB is a no-op unless B was left a Reviewer by a failure mid-check.
    if (flip && bUserId) await setB('creator')
    for (const d of created.drafts) {
      const r = await call(key, 'DELETE', `/api/v1/edits/${d}`)
      log('cleanup_draft', { draftId: d, status: r.status })
    }
    if (lockHeld)
      log('cleanup_lock', {
        status: (await call(key, 'DELETE', `/api/v1/videos/${videoId}/narration-lock`)).status,
      })
    if (restorePrivate !== null) {
      const r = await call(key, 'PATCH', `/api/v1/videos/${videoId}`, { private: restorePrivate })
      log('cleanup_privacy', { private: restorePrivate, status: r.status })
    }
    for (const id of created.takes) {
      const r = await call(key, 'DELETE', `/api/v1/media/${id}`)
      log('cleanup_take', { mediaId: id, status: r.status })
    }
    if (created.takes.length) {
      const foreign = await othersUnused()
      if (!foreign.length || allowDeleteUnused) {
        const r = await call<{ deleted: number }>(key, 'POST', '/api/v1/media/recordings/delete-unused')
        log('cleanup_bytes', { status: r.status, deleted: r.json.deleted })
      } else {
        left.takes = created.takes
        log('cleanup_bytes', {
          skipped: 'A has other unused recordings; these takes are out of the library and go after 30 days',
          mediaIds: created.takes,
        })
      }
    }
  } catch (e) {
    log('cleanup_error', { error: String(e) })
  }
  const summary = {
    videoId,
    passed: passed.length,
    checks: passed,
    created,
    left,
    credits: 0,
    sec: Math.round((Date.now() - started) / 1000),
  }
  finish(failure, summary)
}
