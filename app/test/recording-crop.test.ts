// A demo's crop (docs/guides/screen-recordings.md "Crop"; app/server/lib/recording-crop.ts): the maths (fractions to
// even source pixels, points, boxes, hidden areas and the pointer trace in the cropped picture); the manifest and
// prepare-run (the run's trace.json and input.json are in the cropped picture); the recording check (every scene
// draws exactly the person's crop; the locked areas are compared in the cropped picture, on the run and in finalize);
// and, with ffmpeg, the pipeline on the synthetic recording: analysis of the cropped picture finds the click where it
// is in the crop, the composed scenes carry data-va-crop, sheets, focus crops and hold stills are cut from the crop.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { finalizeRecording } from '../server/domain/finalize-recording.js'
import type { VersionRecording } from '../server/domain/types.js'
import { load, read } from '../server/lib/contract.js'
import {
  cropAttr,
  cropBox,
  cropFilter,
  cropFromFractions,
  cropPoint,
  cropRedact,
  cropTrace,
  parseCropAttr,
  sameCrop,
  type RecordingCrop,
} from '../server/lib/recording-crop.js'
import { parseTrace } from '../server/lib/recording-trace.js'
import { serializeRunManifest, verifyRunManifest, type RunManifest } from '../server/lib/run-manifest.js'
import { analyzeRecording, type Analysis } from '../../scripts/lib/recording-analyze.js'
import { composeDemo } from '../../scripts/lib/recording-compose.js'
import { emitStep } from '../../scripts/lib/recording-emit.js'
import { cachedAnalysis, makeFocusCrops, makeSheets } from '../../scripts/lib/recording-extras.js'
import { checkRecordingScenes } from '../../scripts/lib/recording-inputs.js'
import { planRecording, type PlanInput } from '../../scripts/lib/recording-plan.js'
import { hydrateRecording } from '../../scripts/prepare-run.js'
import { FIXTURE, makeFixture } from './fixtures/recording/make-fixture.js'
import { harness } from './helpers.js'

const tmp = mkdtempSync(join(tmpdir(), 'va-crop-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const CASE = join(import.meta.dirname, 'fixtures', 'recording', 'plans', 'scene-change')
const ID = 'med_golden0001'
const traceText = readFileSync(join(CASE, 'trace.json'), 'utf8')
const input = JSON.parse(readFileSync(join(CASE, 'input.json'), 'utf8')) as PlanInput
const goldenAnalysis = JSON.parse(readFileSync(join(CASE, 'analysis.json'), 'utf8')) as Analysis
// The golden recording is 2560x1440; its left three quarters, under a 144 px bar.
const CROP: RecordingCrop = { x: 0, y: 144, width: 1920, height: 1080, frameWidth: 2560, frameHeight: 1440 }

describe('crop maths', () => {
  it('fractions become even source pixels inside the frame; the whole frame is no crop', () => {
    expect(cropFromFractions([0, 0.1, 0.75, 0.75], 2560, 1440)).toEqual(CROP)
    // Odd results snap to even, and never past the frame.
    expect(cropFromFractions([0.3333, 0.3333, 0.6667, 0.6667], 1279, 721)).toEqual({
      x: 426,
      y: 240,
      width: 852,
      height: 480,
      frameWidth: 1279,
      frameHeight: 721,
    })
    expect(cropFromFractions([0, 0, 1, 1], 1280, 720)).toBeNull()
    expect(cropFromFractions([0.001, 0, 0.999, 1], 1280, 720)).toBeNull()
  })

  it('refuses a crop that is too small or outside the frame, with the reason', () => {
    expect(() => cropFromFractions([0, 0, 0.05, 1], 2560, 1440)).toThrow(/at least 256×160 px/)
    // A tenth of a small frame is under 160 px.
    expect(() => cropFromFractions([0, 0, 0.2, 0.2], 640, 360)).toThrow(/at least 160×160 px/)
    expect(() => cropFromFractions([0.5, 0, 0.6, 1], 1280, 720)).toThrow(/inside the frame/)
    expect(() => cropFromFractions([0, 0, 0, 1], 1280, 720)).toThrow(/fractions of the frame/)
  })

  it('the scene attribute and the ffmpeg filter round-trip', () => {
    expect(cropAttr(CROP)).toBe('0,144,1920,1080,2560,1440')
    expect(parseCropAttr(cropAttr(CROP))).toEqual(CROP)
    expect(cropFilter(CROP)).toBe('crop=1920:1080:0:144')
    for (const bad of [
      null,
      '',
      '0,144,1920,1080',
      '0,144,1920,1080,2560,1440,1',
      'a,b,c,d,e,f',
      '0,144,1920,1400,2560,1440',
    ])
      expect(parseCropAttr(bad), String(bad)).toBeNull()
    expect(sameCrop(CROP, { ...CROP })).toBe(true)
    expect(sameCrop(CROP, { ...CROP, y: 146 })).toBe(false)
    expect(sameCrop(null, undefined)).toBe(true)
    expect(sameCrop(CROP, null)).toBe(false)
  })

  it('points are held at the edge; boxes are cut to the crop and never cover less than they did', () => {
    // The crop is x 0-0.75, y 0.1-0.85 of the frame.
    expect(cropPoint(0.375, 0.475, CROP)).toEqual([0.5, 0.5])
    expect(cropPoint(0.9, 0.05, CROP)).toEqual([1, 0])
    expect(cropBox([0.3, 0.4, 0.15, 0.075], CROP)).toEqual([0.4, 0.4, 0.2, 0.1])
    // Half outside to the right: what's left runs to the edge.
    expect(cropBox([0.6, 0.4, 0.3, 0.075], CROP)).toEqual([0.8, 0.4, 0.2, 0.1])
    // Wholly outside: nothing.
    expect(cropBox([0.8, 0, 0.15, 0.04], CROP)).toEqual([0, 0, 0, 0])
    // Rounded outwards to 4 places.
    const [x, y, w, h] = cropBox([0.1111, 0.2222, 0.3333, 0.1111], CROP)
    expect(x).toBeLessThanOrEqual(0.1111 / 0.75)
    expect(y).toBeLessThanOrEqual((0.2222 - 0.1) / 0.75)
    expect(x + w).toBeGreaterThanOrEqual((0.1111 + 0.3333) / 0.75 - 1e-9)
    expect(y + h).toBeGreaterThanOrEqual((0.2222 + 0.1111 - 0.1) / 0.75 - 1e-9)
  })

  it('hidden areas: keys outside the crop hide nothing; an area never inside it is left out', () => {
    const out = cropRedact(
      [
        {
          start: 0,
          end: 20,
          reason: 'api key',
          boxes: [
            [0, 0.1, 0.8, 0.3, 0.03],
            [10, 0.1, 0.9, 0.3, 0.05],
          ],
        },
        { start: 0, end: 20, reason: 'email', boxes: [[0, 0.8, 0.02, 0.15, 0.04]] },
      ],
      CROP,
    )
    expect(out).toEqual([
      {
        start: 0,
        end: 20,
        reason: 'api key',
        boxes: [
          [0, 0.1333, 0.9333, 0.4001, 0.0401],
          [10, 0, 0, 0, 0],
        ],
      },
    ])
    expect(cropRedact(out, null)).toEqual(out)
  })

  it('the pointer trace: cursor held at the edge, clicks outside dropped, boxes cut, still a valid trace', () => {
    const trace = parseTrace(traceText)
    const c = cropTrace(trace, CROP)
    expect(c.frame).toMatchObject({ width: 1920, height: 1080 })
    expect(c.moves).toHaveLength(trace.moves.length)
    expect(c.moves.every(([, x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)).toBe(true)
    const clicks = c.events.filter((e) => e.kind === 'click')
    // Both golden clicks are inside: (0.3, 0.3) and (0.7, 0.5) of the frame.
    expect(clicks.map((e) => [e.x, e.y])).toEqual([
      [0.4, 0.2667],
      [0.9333, 0.5333],
    ])
    expect(clicks[0]?.target?.box).toEqual([0.3466, 0.2466, 0.1068, 0.0401])
    expect(c.events.filter((e) => e.kind === 'navigate')).toHaveLength(1)
    // A crop that leaves the second click out.
    const left = cropTrace(trace, { ...CROP, width: 1280 })
    expect(left.events.filter((e) => e.kind === 'click')).toHaveLength(1)
    // It parses as a trace again, unchanged.
    expect(parseTrace(JSON.stringify(c))).toEqual(c)
    expect(cropTrace(trace, null)).toBe(trace)
  })
})

describe('crop: manifest and prepare-run', () => {
  const media = [
    { key: `${ID}/original.mp4`, sha256: 'a'.repeat(64), filename: `${ID}.mp4`, kind: 'video' as const },
  ]
  const manifest = (crop: unknown): RunManifest =>
    ({
      v: 1,
      jobId: 'vid_1',
      attemptId: 'att_1',
      versionN: 1,
      kind: 'author',
      source: null,
      bundle: null,
      media,
      feedback: null,
      recording: {
        mediaId: ID,
        key: `${ID}/original.mp4`,
        sha256: 'a'.repeat(64),
        filename: `${ID}.mp4`,
        boxes: [],
        ...(crop === undefined ? {} : { crop }),
      },
    }) as unknown as RunManifest
  const verify = (m: RunManifest, raw = false) => {
    const text = raw ? JSON.stringify(m) : serializeRunManifest(m)
    return verifyRunManifest(text, { attemptId: 'att_1', sha256: sha(text) })
  }

  it('the manifest carries the crop, keeps its bytes without one, and refuses a bad one', () => {
    expect(verify(manifest(CROP)).recording?.crop).toEqual(CROP)
    expect(serializeRunManifest(manifest(undefined))).not.toContain('crop')
    for (const bad of [{ ...CROP, x: 1000 }, { ...CROP, width: 1.5 }, { x: 0, y: 0 }, 'all', null])
      expect(() => verify(manifest(bad), true), JSON.stringify(bad)).toThrow()
  })

  it('hydrates the trace and input.json in the cropped picture', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = join(tmp, 'hydrate')
    const boxes = cropRedact(input.boxes ?? [], { ...CROP, width: 2560 })
    await hydrateRecording(
      dir,
      {
        mediaId: ID,
        key: `${ID}/original.mp4`,
        sha256: 'a'.repeat(64),
        filename: `${ID}.mp4`,
        trace: { key: `${ID}/trace.json`, sha256: sha(traceText) },
        boxes,
        crop: CROP,
      },
      (_key, to) => {
        writeFileSync(to, traceText)
        return Promise.resolve()
      },
    )
    const run = join(dir, '.va-run', 'recording', ID)
    expect(parseTrace(readFileSync(join(run, 'trace.json'), 'utf8'))).toEqual(
      cropTrace(parseTrace(traceText), CROP),
    )
    expect(JSON.parse(readFileSync(join(run, 'input.json'), 'utf8'))).toEqual({ boxes, crop: CROP })
    vi.restoreAllMocks()
  })
})

/**
 * The golden demo composed as a cropped one: the trace and the setup boxes converted as prepare-run and demo creation
 * do, the analysis marked with the crop (its positions don't matter to the check).
 */
function croppedDemo(dir: string) {
  const analysis: Analysis = {
    ...goldenAnalysis,
    source: { ...goldenAnalysis.source, width: CROP.width, height: CROP.height },
    crop: CROP,
  }
  const trace = cropTrace(parseTrace(traceText), CROP)
  // The golden setup box is in the top right corner, outside this crop; one inside it too.
  const drawn = [
    ...(input.boxes ?? []),
    {
      start: 0,
      end: 20,
      reason: 'Hidden by you',
      boxes: [[0, 0.3, 0.4, 0.15, 0.075]] as [number, number, number, number, number][],
    },
  ]
  const boxes = cropRedact(drawn, CROP)
  const { plan } = planRecording({ mediaId: ID, analysis, trace, input: { boxes } })
  mkdirSync(dir, { recursive: true })
  composeDemo({ videoDir: dir, plan, analysis, trace })
  writeFileSync(join(dir, 'assets', 'recording', 'analysis.json'), JSON.stringify(analysis))
  return { analysis, trace, boxes, plan }
}

describe('crop: the recording check', () => {
  let n = 0
  function runRoot(inputCrop: RecordingCrop | null) {
    const root = join(tmp, `check${String(n++)}`)
    const video = join(root, 'video')
    const { trace, boxes } = croppedDemo(video)
    mkdirSync(join(root, '.render'), { recursive: true })
    mkdirSync(join(root, '.va-run', 'recording', ID), { recursive: true })
    writeFileSync(join(root, '.va-run', 'recording', ID, 'trace.json'), JSON.stringify(trace))
    writeFileSync(
      join(root, '.va-run', 'recording', ID, 'input.json'),
      JSON.stringify({ boxes, ...(inputCrop ? { crop: inputCrop } : {}) }),
    )
    writeFileSync(
      join(root, '.render', 'run-manifest.json'),
      JSON.stringify({ v: 1, kind: 'author', recording: { mediaId: ID, filename: `${ID}.mp4` } }),
    )
    return { root, index: join(video, 'index.html') }
  }
  const problems = (root: string, html: string) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    return checkRecordingScenes(root, html).map((p) => `${p.scene}:${p.rule}`)
  }

  it('every scene carries the crop; the locked areas are the cropped ones (one setup box is outside it)', () => {
    const { root, index } = runRoot(CROP)
    const html = readFileSync(index, 'utf8')
    const beats = read(load(html)).beats.filter((b) => b.recording)
    expect(beats.length).toBeGreaterThan(0)
    for (const b of beats) expect(b.recording?.crop).toEqual(CROP)
    expect(html).toContain(`<div class="va-stage" data-va-crop="${cropAttr(CROP)}" data-va-camera=`)
    const locked = readFileSync(join(root, 'video', 'assets', 'recording', 'redact.js'), 'utf8')
    expect((locked.match(/"id":"[ts]\d"/g) ?? []).sort()).toEqual(['"id":"s1"', '"id":"t1"'])
    expect(problems(root, html)).toEqual([])
  })

  it('refuses a scene whose crop was changed or removed, and a crop on a demo that has none', () => {
    const { root, index } = runRoot(CROP)
    const html = readFileSync(index, 'utf8')
    const moved = html.replace(`data-va-crop="${cropAttr(CROP)}"`, 'data-va-crop="0,0,1920,1080,2560,1440"')
    expect(problems(root, moved)).toContain('step-1:crop')
    const removed = html.replaceAll(` data-va-crop="${cropAttr(CROP)}"`, '')
    expect(new Set(problems(root, removed))).toEqual(new Set(['step-1:crop', 'step-2:crop']))
    const none = runRoot(null)
    expect(problems(none.root, readFileSync(none.index, 'utf8'))).toEqual(
      expect.arrayContaining(['step-1:crop']),
    )
  })
})

describe('crop: finalize', () => {
  const files = (dir: string) => {
    const out = new Map<string, Uint8Array>()
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else out.set(relative(dir, p), new Uint8Array(readFileSync(p)))
      }
    }
    walk(dir)
    return out
  }

  it("compares the stored trace's hidden areas in the cropped picture; without the crop they'd read as moved", async () => {
    const h = harness()
    const JOB = 'vid_crop'
    await h.deps.blobs.set('media', `${ID}/trace.json`, traceText)
    await h.deps.store.insertVersionMedia([
      {
        jobId: JOB,
        versionN: 1,
        mediaId: ID,
        position: 0,
        kind: 'video',
        key: `${ID}/original.mp4`,
        sha256: 'a'.repeat(64),
        filename: `${ID}.mp4`,
        caption: null,
      },
    ])
    const dir = join(tmp, 'finalize')
    const { boxes } = croppedDemo(dir)
    const rec: VersionRecording = {
      mediaId: ID,
      trace: { key: `${ID}/trace.json`, sha256: sha(traceText) },
      trim: null,
      boxes,
      crop: CROP,
      compose: false,
      summary: null,
      hidden: [],
    }
    const version = { authorId: 'u_1', parentN: null, editedFromN: null, mode: 'author' as const }
    const good = await finalizeRecording(h.deps, JOB, 1, { ...version, recording: rec }, files(dir))
    expect(good?.ok).toBe(true)
    if (good?.ok)
      expect([...new Set(good.recording.hidden.map((x) => `${x.id}:${x.source}`))]).toEqual([
        't1:trace',
        's1:setup',
      ])
    // The same composition against a version with no crop: its scenes' crop, and its trace areas, don't match.
    const uncropped = { ...rec }
    delete uncropped.crop
    const bad = await finalizeRecording(h.deps, JOB, 1, { ...version, recording: uncropped }, files(dir))
    expect(bad).toMatchObject({ ok: false, code: 'redaction_removed' })
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const size = (file: string) =>
  spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  ).stdout.trim()

describe.runIf(hasFfmpeg)('crop: the pipeline on a recording', () => {
  // The synthetic recording is 1280x720; this keeps the click (812, 412) and its card, and cuts the sidebar and bar.
  const crop: RecordingCrop = { x: 400, y: 200, width: 800, height: 450, frameWidth: 1280, frameHeight: 720 }
  const MEDIA = 'med_crop0001'
  let file = ''
  let analysis: Analysis
  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    file = makeFixture(join(tmp, 'fixture.mp4'))
    analysis = await analyzeRecording(file, null, crop)
  })

  it('analysis is of the cropped picture: its size, the click where it is in the crop', () => {
    expect(analysis.source).toMatchObject({ width: 800, height: 450, duration: FIXTURE.seconds })
    expect(analysis.crop).toEqual(crop)
    const click = analysis.clicks[0]
    console.log(JSON.stringify({ test: 'recording-crop', clicks: analysis.clicks, scenes: analysis.scenes }))
    expect(click).toBeTruthy()
    expect(Math.abs((click?.t ?? 0) - FIXTURE.click.t)).toBeLessThanOrEqual(0.1)
    expect(Math.abs((click?.x ?? 0) - (FIXTURE.click.x - crop.x))).toBeLessThanOrEqual(0.02 * 1280)
    expect(Math.abs((click?.y ?? 0) - (FIXTURE.click.y - crop.y))).toBeLessThanOrEqual(0.02 * 720)
    // Nothing is placed outside the cropped picture.
    for (const [, x, y, w, h] of analysis.activity) {
      expect(x + w).toBeLessThanOrEqual(800 + 3)
      expect(y + h).toBeLessThanOrEqual(450 + 3)
    }
    for (const [, x, y] of analysis.cursor) {
      expect(x).toBeLessThanOrEqual(800)
      expect(y).toBeLessThanOrEqual(450)
    }
  })

  it('a crop for another frame size is refused; the cache is per crop', async () => {
    await expect(
      analyzeRecording(file, null, { ...crop, frameWidth: 1920, frameHeight: 1080 }),
    ).rejects.toThrow(/1920×1080 recording, but this one is 1280×720/)
    const path = join(tmp, 'cached-analysis.json')
    writeFileSync(path, JSON.stringify(analysis))
    expect(cachedAnalysis(path, analysis.sha256, crop)).toEqual(analysis)
    expect(cachedAnalysis(path, analysis.sha256, null)).toBeNull()
    expect(cachedAnalysis(path, analysis.sha256, { ...crop, x: 402 })).toBeNull()
  })

  it('sheets, focus crops and hold stills are cut from the crop; scenes carry it and pass the check', () => {
    const root = join(tmp, 'pipeline')
    const video = join(root, 'video')
    mkdirSync(join(video, 'assets', 'media'), { recursive: true })
    copyFileSync(file, join(video, 'assets', 'media', `${MEDIA}.mp4`))
    const { plan } = planRecording({ mediaId: MEDIA, analysis, trace: null })
    expect(plan.frame).toEqual({ width: 800, height: 450 })
    // An 800x450 picture is drawn large already: the camera may not zoom far and stay sharp.
    expect(plan.zoomMax).toBeLessThan(1.4)

    const sheets = join(root, 'context', 'sheets')
    const made = makeSheets(file, analysis, sheets)
    expect(made.length).toBeGreaterThan(0)
    // 4 x 3 tiles, 320 wide, of a 16:9 crop.
    expect(size(join(sheets, made[0]?.file ?? ''))).toBe('1280,540')

    const focus = join(root, 'context', 'focus')
    const crops = makeFocusCrops(file, plan, analysis, focus)
    for (const c of crops) {
      const [x, y, w, h] = c.box
      expect(x + w).toBeLessThanOrEqual(800)
      expect(y + h).toBeLessThanOrEqual(450)
      expect(size(join(focus, c.file))).toMatch(/^1280,/)
    }

    composeDemo({ videoDir: video, plan, analysis, trace: null })
    writeFileSync(join(video, 'assets', 'recording', 'analysis.json'), JSON.stringify(analysis))
    const html = readFileSync(join(video, 'index.html'), 'utf8')
    expect(html).toContain(`data-va-crop="${cropAttr(crop)}"`)
    mkdirSync(join(root, '.va-run', 'recording', MEDIA), { recursive: true })
    writeFileSync(
      join(root, '.va-run', 'recording', MEDIA, 'input.json'),
      JSON.stringify({ boxes: [], crop }),
    )
    mkdirSync(join(root, '.render'), { recursive: true })
    writeFileSync(
      join(root, '.render', 'run-manifest.json'),
      JSON.stringify({ v: 1, kind: 'author', recording: { mediaId: MEDIA, filename: `${MEDIA}.mp4` } }),
    )
    expect(checkRecordingScenes(root, html)).toEqual([])

    // A scene slower than 0.5x holds its last frame: the still is the cropped picture.
    const step = plan.steps[0]
    if (!step) throw new Error('no step')
    const held = emitStep({
      videoDir: video,
      plan,
      step: step.id,
      analysis,
      trace: null,
      duration: (step.out - step.in) * 3,
    })
    expect(held.hold).toBe(true)
    expect(size(join(video, 'assets', 'recording', `${step.id}.hold.jpg`))).toBe('800,450')
  })
})
