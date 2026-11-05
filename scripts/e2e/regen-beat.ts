// Live test for redo a scene (docs/plans/2026-11-04-regenerate-beat.md §10; beads va-8cy4.3.9, LT-1, LT-2). Spends
// credits: each scoped run about 60 (spike B3: 57.6), a whole-video baseline about 120. CREDIT_CEILING (default 700)
// refuses to start a run once the credits so far plus its projection would pass it.
//
//   npx tsx scripts/e2e/regen-beat.ts --dry        # checks the env, prints the steps and credits; no network
//   npx tsx scripts/e2e/regen-beat.ts --selftest   # the frame and caption analysis on local fixtures; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… NETLIFY_SITE_ID=<site id> SOURCE_ID=vid_… \
//     [VOICED_ID=vid_…] [NARRATED_ID=vid_…] [BASELINE=1] [CREDIT_CEILING=700] \
//     npx tsx scripts/e2e/regen-beat.ts [--steps 1,2]
//
// SOURCE_ID is a ready contract-v1 test video with three or more scenes and music. The versions this adds to the
// videos it's given are kept (versions can't be deleted on their own), so give it test videos. Saved compositions are
// read from the site's sources store with the Netlify CLI, run outside the repo. Steps, each logged as JSON lines:
//   1. Scoped, same length: redo the middle scene ("Ship on Friday"). Ready, scope recorded, same scenes in order, the
//      scene's captions have the phrase, the other scenes' captions are the parent's, their frames match the parent's
//      (SSIM_MIN per frame, SSIM_TILE_MIN on the worst 4x4 tile, every 0.5 s at matched scene times), music kept.
//   2. Bad requests (no credits): an unknown scene, every scene, scope without fromVersion, planId with scope.
//   3. Baseline (BASELINE=1): the same request as a whole-video revision; its out-of-scope SSIM shows full-revision drift.
//   4. Scoped, longer: the scene twice as long; later scenes move by the delta and keep their lengths, their captions
//      shift by it, the root grows by it and the MP4 matches the composition.
//   5. Voiced (VOICED_ID): change a scene's line in words; only that scene's voice entry and WAV change.
//   6. Narrated (NARRATED_ID): redo a middle scene; the length is unchanged and the narration element is the parent's.
// Pass: every step run passes; scoped median credits ≤ 60% of a full revision's (step 3 with BASELINE=1, else the
// parent version's own credits; the summary says which). Exits non-zero on a failed check.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attr, load, read, walk, type Caption, type Summary } from '../../src/lib/contract.js'
import { readTarGz } from '../../src/lib/tar.js'
import { key, log } from './lib.js'
import { sampleFrame, ssim, tileSsim } from './lib/ssim.js'
import { call, check, download, dry, dryRun, GateError, sleep } from './narration-lib.js'

const env = process.env
const SSIM_MIN = Number(env.SSIM_MIN ?? 0.98)
const SSIM_TILE_MIN = Number(env.SSIM_TILE_MIN ?? 0.955)
const SCOPED_CREDITS = 60
const FULL_CREDITS = 120
const ceiling = Number(env.CREDIT_CEILING ?? 700)
const steps = new Set(
  (process.argv.includes('--steps')
    ? (process.argv[process.argv.indexOf('--steps') + 1] ?? '')
    : '1,2,3,4,5,6'
  )
    .split(',')
    .map(Number),
)
const site = env.NETLIFY_SITE_ID ?? ''
const sourceId = env.SOURCE_ID ?? ''
const voicedId = env.VOICED_ID ?? ''
const narratedId = env.NARRATED_ID ?? ''
const baseline = env.BASELINE === '1'

// ───── the analysis (also what --selftest exercises) ─────

/** Frames of a scene in two MP4s at the same moments of the scene, every 0.5 s: the lowest whole-frame and tile SSIM. */
export function sceneDrift(
  a: string,
  aStart: number,
  b: string,
  bStart: number,
  duration: number,
  dir: string,
) {
  let frame = 1
  let tile = 1
  for (let t = 0.25; t < duration - 0.05; t += 0.5) {
    const fa = join(dir, `a-${aStart}-${t}.png`)
    const fb = join(dir, `b-${bStart}-${t}.png`)
    sampleFrame(a, aStart + t, fa)
    sampleFrame(b, bStart + t, fb)
    frame = Math.min(frame, ssim(fa, fb))
    tile = Math.min(tile, tileSsim(fa, fb))
  }
  return { frame, tile }
}

/** The cues of a scene, beat-relative, comparable across versions (text, text id, times to the millisecond). */
export const sceneCues = (s: Summary, beat: string) =>
  (s.captions ?? [])
    .filter((c: Caption) => c.beat === beat)
    .map((c) => JSON.stringify([c.textId ?? null, c.text, !!c.voice, ms(c.beatStart), ms(c.beatEnd)]))
    .sort()
const ms = (n: number | undefined) => (n === undefined ? null : Math.round(n * 1000))

if (process.argv.includes('--selftest')) {
  const dir = mkdtempSync(join(tmpdir(), 'va-regen-self-'))
  const fx = (f: string) => join(process.cwd(), 'test/fixtures', f)
  const same = sceneDrift(fx('a169.mp4'), 0, fx('a169.mp4'), 0, 2, dir)
  check(same.frame > 0.999 && same.tile > 0.999, 'a video against itself has no drift', same)
  const pic = (out: string, filter?: string) =>
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:d=2:r=30',
      ...(filter ? ['-vf', filter] : []),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      out,
    ])
  pic(join(dir, 'bars.mp4'))
  pic(join(dir, 'marked.mp4'), 'drawbox=x=10:y=10:w=60:h=16:color=white:t=fill')
  const small = sceneDrift(join(dir, 'bars.mp4'), 0, join(dir, 'marked.mp4'), 0, 2, dir)
  check(small.tile < SSIM_TILE_MIN, 'a small change shows in its tile', small)
  const cues: Summary = {
    captions: [{ start: 3.5, end: 5, text: 'Hi', beat: 'b', textId: 'b-t', beatStart: 0.5, beatEnd: 2 }],
  }
  const shifted: Summary = {
    captions: [{ start: 5.5, end: 7, text: 'Hi', beat: 'b', textId: 'b-t', beatStart: 0.5, beatEnd: 2 }],
  }
  check(sceneCues(cues, 'b').join() === sceneCues(shifted, 'b').join(), 'a shifted scene keeps its cues')
  rmSync(dir, { recursive: true, force: true })
  log('SELFTEST_OK', { same, small })
  process.exit(0)
}

if (dry)
  dryRun({
    script: 'scripts/e2e/regen-beat.ts',
    required: {
      VIDEO_AGENT_URL: env.VIDEO_AGENT_URL,
      VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY,
      NETLIFY_SITE_ID: site,
      SOURCE_ID: sourceId,
    },
    optional: {
      VOICED_ID: voicedId,
      NARRATED_ID: narratedId,
      BASELINE: env.BASELINE,
      CREDIT_CEILING: env.CREDIT_CEILING,
    },
    steps: [
      '1. Scoped, same length: redo the middle scene of SOURCE_ID; check scope, scenes, captions, frames (SSIM) and music.',
      '2. Bad requests (no credits): unknown scene, every scene, scope without fromVersion, planId with scope.',
      `3. Baseline: ${baseline ? 'the same request as a whole-video revision' : 'skipped (BASELINE=1 runs it)'}.`,
      '4. Scoped, longer: the scene twice as long; later scenes, captions, root and MP4 move by the delta.',
      `5. Voiced: ${voicedId ? 'change a scene line of VOICED_ID' : 'skipped (no VOICED_ID)'}.`,
      `6. Narrated: ${narratedId ? 'redo a middle scene of NARRATED_ID; length and narration unchanged' : 'skipped (no NARRATED_ID)'}.`,
      'Versions added to these videos are kept: use test videos.',
    ].filter((s) => steps.has(Number(s[0]))),
    credits: {
      scopedRuns: [1, 4, ...(voicedId ? [5] : []), ...(narratedId ? [6] : [])].filter((s) => steps.has(s))
        .length,
      perScoped: SCOPED_CREDITS,
      baseline: baseline && steps.has(3) ? FULL_CREDITS : 0,
      projected:
        [1, 4, ...(voicedId ? [5] : []), ...(narratedId ? [6] : [])].filter((s) => steps.has(s)).length *
          SCOPED_CREDITS +
        (baseline && steps.has(3) ? FULL_CREDITS : 0),
      ceiling,
    },
  })

// ───── live ─────

interface Version {
  n: number
  status: string
  editable: boolean
  beats: { id: string; label: string | null; start: number; duration: number }[] | null
  scope: { beats: { id: string; label: string }[] } | null
  usage: { totalCreditsCost?: number } | null
  links?: { video?: string } | null
  output: { durationSec: number } | null
  error?: unknown
}
const work = mkdtempSync(join(tmpdir(), 'va-regen-'))
let creditsUsed = 0
const runs: {
  step: number
  videoId: string
  n: number
  credits: number | null
  sec: number
  scoped: boolean
}[] = []
const passed: string[] = []
const ok = (name: string, f: Record<string, unknown> = {}) => {
  passed.push(name)
  log('ok', { check: name, ...f })
}

const videoOf = async (id: string) =>
  (await call<{ versions: Version[] }>(key, 'GET', `/api/v1/videos/${id}`)).json.versions
const files = (id: string, n: number) => {
  const out = join(work, `${id}-v${n}.tar.gz`)
  const r = spawnSync('netlify', ['blobs:get', 'sources', `${id}/v${n}.tar.gz`, '--output', out], {
    cwd: work,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NETLIFY_SITE_ID: site },
  })
  if (r.status !== 0)
    throw new GateError(`Can't read ${id} v${n}'s saved composition.`, { stderr: r.stderr.slice(-300) })
  return readTarGz(readFileSync(out), { maxEntries: 5000, maxTotalBytes: 160e6, maxFileBytes: 60e6 })
}
const text = (m: Map<string, Uint8Array>, p: string) => new TextDecoder().decode(m.get(p) ?? new Uint8Array())
const mp4 = async (id: string, v: Version) => {
  const out = join(work, `${id}-v${v.n}.mp4`)
  const r = await download(key, v.links?.video ?? `/api/v1/videos/${id}/versions/${v.n}/video`)
  check(r.status === 200, `the MP4 of ${id} v${v.n} downloads`, { status: r.status })
  writeFileSync(out, r.bytes)
  return out
}

/** Starts a revision (scoped when `beats`), waits for it, records its credits. */
async function revise(step: number, id: string, from: number, change: string, beats?: string[]) {
  const projected = beats ? SCOPED_CREDITS : FULL_CREDITS
  if (creditsUsed + projected > ceiling)
    throw new GateError('CREDIT_CEILING reached; not starting another run.', { creditsUsed, ceiling })
  const t0 = Date.now()
  const r = await call<{ versions: Version[] }>(key, 'POST', `/api/v1/videos/${id}/versions`, {
    prompt: change,
    fromVersion: from,
    ...(beats ? { scope: { beats } } : {}),
  })
  check(r.status === 202, `step ${step}: the revision is accepted`, {
    status: r.status,
    body: r.text.slice(0, 300),
  })
  const n = Math.max(...r.json.versions.map((v) => v.n))
  let v: Version | undefined
  for (;;) {
    await sleep(15_000)
    v = (await videoOf(id)).find((x) => x.n === n)
    if (v && ['ready', 'failed', 'cancelled', 'timed_out'].includes(v.status)) break
    if (Date.now() - t0 > 30 * 60_000) break
  }
  const credits = v?.usage?.totalCreditsCost ?? null
  creditsUsed += credits ?? projected
  const sec = Math.round((Date.now() - t0) / 1000)
  runs.push({ step, videoId: id, n, credits, sec, scoped: !!beats })
  log('run', { step, videoId: id, version: n, status: v?.status, credits, sec })
  check(v?.status === 'ready', `step ${step}: the version is ready`, { status: v?.status, error: v?.error })
  return v
}

/** The checks shared by scoped steps: scenes in order, frozen scenes' captions and frames the parent's (shifted). */
async function frozenUnchanged(step: number, id: string, parent: Version, child: Version, scoped: string[]) {
  const [pf, cf] = [files(id, parent.n), files(id, child.n)]
  const [pc, cc] = [read(load(text(pf, 'index.html'))), read(load(text(cf, 'index.html')))]
  check(
    pc.beats.map((b) => b.id).join() === cc.beats.map((b) => b.id).join(),
    `step ${step}: same scenes in order`,
  )
  const [ps, cs] = [
    JSON.parse(text(pf, 'summary.json')) as Summary,
    JSON.parse(text(cf, 'summary.json')) as Summary,
  ]
  const [pm, cm] = [await mp4(id, parent), await mp4(id, child)]
  for (const b of pc.beats.filter((x) => !scoped.includes(x.id))) {
    const nb = must(
      cc.beats.find((x) => x.id === b.id),
      `step ${step}: scene "${b.id}" is missing`,
    )
    check(
      sceneCues(ps, b.id).join() === sceneCues(cs, b.id).join(),
      `step ${step}: scene "${b.id}" keeps its captions`,
    )
    check(String(nb.duration) === String(b.duration), `step ${step}: scene "${b.id}" keeps its length`, {
      was: b.duration,
      now: nb.duration,
    })
    const drift = sceneDrift(pm, b.start, cm, nb.start, b.duration, work)
    log('drift', { step, scene: b.id, ...drift })
    check(
      drift.frame >= SSIM_MIN && drift.tile >= SSIM_TILE_MIN,
      `step ${step}: scene "${b.id}" looks the same`,
      drift,
    )
  }
  return { pc, cc, cs, pf, cf, html: text(cf, 'index.html') }
}

/** The value, or a failed check saying what was missing. */
function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new GateError(what)
  return v
}
/** The middle scene (not the held last frame) of a version's scenes. */
const middleOf = (beats: Version['beats'], what: string) => {
  const real = must(beats, `${what} has no scenes`).filter((b) => b.id !== 'va-hold')
  return must(real[Math.floor((real.length - 1) / 2)], `${what} has no scenes`).id
}

let failure: Error | null = null
try {
  const versions = await videoOf(sourceId)
  const parent = versions.find((v) => v.status === 'ready')
  check(
    !!parent?.editable && !!parent.beats && parent.beats.length >= 3,
    'SOURCE_ID has an editable ready version with 3+ scenes',
    { n: parent?.n },
  )
  const p = parent
  const pBeats = must(p.beats, 'SOURCE_ID has no scenes')
  const middle = middleOf(pBeats, 'SOURCE_ID')

  if (steps.has(1)) {
    const v = await revise(
      1,
      sourceId,
      p.n,
      "Make the headline say 'Ship on Friday' and slide it in from the left.",
      [middle],
    )
    check(v.scope?.beats.map((b) => b.id).join() === middle, 'step 1: scope recorded', { scope: v.scope })
    const r = await frozenUnchanged(1, sourceId, p, v, [middle])
    check(
      sceneCues(r.cs, middle).join(' ').includes('Ship on Friday'),
      "step 1: the scene's captions have the phrase",
    )
    check(/data-va-layer="music"/.test(r.html), 'step 1: the music is still there')
    ok('step 1')
  }
  if (steps.has(2)) {
    const bad = async (name: string, body: Record<string, unknown>, status: number) => {
      const r = await call(key, 'POST', `/api/v1/videos/${sourceId}/versions`, {
        prompt: 'Redo it.',
        ...body,
      })
      check(r.status === status, `step 2: ${name} is refused with ${status}`, {
        status: r.status,
        body: r.text.slice(0, 200),
      })
    }
    await bad('an unknown scene', { fromVersion: p.n, scope: { beats: ['no-such-scene'] } }, 400)
    await bad('every scene', { fromVersion: p.n, scope: { beats: pBeats.map((b) => b.id) } }, 400)
    await bad('scope without fromVersion', { scope: { beats: [middle] } }, 400)
    await bad('planId with scope', { fromVersion: p.n, planId: 'pln_x', scope: { beats: [middle] } }, 400)
    ok('step 2')
  }
  if (steps.has(3) && baseline) {
    const v = await revise(
      3,
      sourceId,
      p.n,
      "Make the headline say 'Ship on Friday' and slide it in from the left.",
    )
    const [pm, cm] = [await mp4(sourceId, p), await mp4(sourceId, v)]
    const cb = read(load(text(files(sourceId, v.n), 'index.html'))).beats
    for (const b of pBeats.filter((x) => x.id !== middle)) {
      const nb = cb.find((x) => x.id === b.id)
      if (nb)
        log('baseline_drift', {
          scene: b.id,
          ...sceneDrift(pm, b.start, cm, nb.start, Math.min(b.duration, nb.duration), work),
        })
    }
    ok('step 3')
  }
  if (steps.has(4)) {
    const v = await revise(4, sourceId, p.n, 'Make this scene twice as long so people can read the list.', [
      middle,
    ])
    const r = await frozenUnchanged(4, sourceId, p, v, [middle])
    const was = must(
      r.pc.beats.find((b) => b.id === middle),
      'step 4: the scene',
    ).duration
    const now = must(
      r.cc.beats.find((b) => b.id === middle),
      'step 4: the scene',
    ).duration
    const delta = now - was
    check(delta > 0.5, 'step 4: the scene got longer', { was, now })
    const root = (h: string) => Number(attr(load(h).root, 'data-duration'))
    const total = root(r.html)
    check(
      Math.abs(total - root(text(r.pf, 'index.html')) - delta) < 0.01,
      'step 4: the video is longer by the delta',
    )
    check(Math.abs((v.output?.durationSec ?? 0) - total) <= 0.25, 'step 4: the MP4 matches the composition', {
      mp4: v.output?.durationSec,
      total,
    })
    ok('step 4', { delta })
  }
  if (steps.has(5) && voicedId) {
    const vp = must(
      (await videoOf(voicedId)).find((v) => v.status === 'ready'),
      'VOICED_ID has a ready version',
    )
    const scene = middleOf(vp.beats, 'VOICED_ID')
    const v = await revise(
      5,
      voicedId,
      vp.n,
      'Change what the narrator says in this scene to: "Ship on Friday, every Friday."',
      [scene],
    )
    const [pf, cf] = [files(voicedId, vp.n), files(voicedId, v.n)]
    const entries = (m: Map<string, Uint8Array>) =>
      new Map(
        (JSON.parse(text(m, 'assets/voice/voice.json')) as { beats: { beat: string }[] }).beats.map((b) => [
          b.beat,
          JSON.stringify(b),
        ]),
      )
    const [pe, ce] = [entries(pf), entries(cf)]
    for (const [beat, entry] of pe)
      if (beat !== scene) check(ce.get(beat) === entry, `step 5: scene "${beat}"'s voice is unchanged`)
    ok('step 5')
  }
  if (steps.has(6) && narratedId) {
    const np = must(
      (await videoOf(narratedId)).find((v) => v.status === 'ready'),
      'NARRATED_ID has a ready version',
    )
    const scene = middleOf(np.beats, 'NARRATED_ID')
    const v = await revise(6, narratedId, np.n, 'Make the headline in this scene bigger and bolder.', [scene])
    const [pf, cf] = [files(narratedId, np.n), files(narratedId, v.n)]
    const narration = (m: Map<string, Uint8Array>) => {
      const e = [...walk(load(text(m, 'index.html')).root)].find((x) => attr(x, 'id') === 'va-narration')
      return e ? JSON.stringify([...e.attrs].sort((a, b) => a.name.localeCompare(b.name))) : null
    }
    check(
      narration(pf) !== null && narration(pf) === narration(cf),
      'step 6: the narration element is the parent’s',
    )
    const root = (m: Map<string, Uint8Array>) => attr(load(text(m, 'index.html')).root, 'data-duration')
    check(root(pf) === root(cf), 'step 6: the length is unchanged', { was: root(pf), now: root(cf) })
    ok('step 6')
  }
} catch (e) {
  failure = e instanceof Error ? e : new Error(String(e))
} finally {
  const scoped = runs
    .flatMap((r) => (r.scoped && r.credits !== null ? [r.credits] : []))
    .sort((a, b) => a - b)
  const median = scoped[Math.floor((scoped.length - 1) / 2)] ?? null
  const full = runs.find((r) => !r.scoped)?.credits ?? null
  log('summary', {
    passed,
    runs,
    creditsUsed: Math.round(creditsUsed * 100) / 100,
    ceiling,
    scopedMedianCredits: median,
    fullRevisionCredits: full,
    fullRevisionFrom: full !== null ? 'step 3 baseline' : 'parent version credits (see the source video)',
    savingsBar: median !== null && full !== null ? median <= 0.6 * full : null,
  })
  if (!failure && env.KEEP_FILES !== '1') rmSync(work, { recursive: true, force: true })
  if (failure) {
    log('FAIL', { message: failure.message, ...(failure instanceof GateError ? failure.fields : {}) })
    process.exitCode = 1
  }
}
