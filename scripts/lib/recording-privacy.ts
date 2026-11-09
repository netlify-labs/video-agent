// Privacy mode on the runner (screen-recording plan §5.3, "Privacy mode"): OCR of sampled frames finds what the person
// asked to hide (their hide strings) and, in privacy mode, the recommended patterns (app/server/lib/privacy-patterns.ts). Each
// thing found becomes a candidate hidden area: keyframed boxes over the frames it was read in, a time span out to the
// frames either side where it wasn't (hiding a little too long is safe; too short shows it), and a crop for the agent
// to confirm. Runs only when privacy mode or hide strings are set, and
// within a time budget: frames are sampled at each scene start and every SAMPLE_EVERY_S of the rest (idle stretches
// once), at most MAX_FRAMES, and the scan stops when the budget runs out, saying so.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { findPrivate, PRIVACY_LABELS, type PrivacyKind } from '../../app/server/lib/privacy-patterns.js'
import type { Analysis } from './recording-analyze.js'
import { log } from './run-tools.js'

export const SAMPLE_EVERY_S = 1.5
export const MAX_FRAMES = 60
export const BUDGET_MS = 90_000
/** Padding around a match, in source px, so a box covers the glyphs' edges. */
const PAD_PX = 4

export interface OcrWord {
  text: string
  /** Source px. */
  x0: number
  y0: number
  x1: number
  y1: number
}
/** One OCR'd frame: its lines, each a list of words in reading order. */
export type OcrFrame = OcrWord[][]
export type Ocr = (png: string) => Promise<OcrFrame>

export interface Detection {
  kind: PrivacyKind
  text: string
  /** [x, y, w, h] as fractions of the frame. */
  box: [number, number, number, number]
}

export interface PrivacyCandidate {
  id: string
  kind: PrivacyKind
  /** The agent's reason when it keeps it: "Privacy mode: email". */
  reason: string
  start: number
  end: number
  /** [t, x, y, w, h] keys: where it was read, as fractions of the frame. */
  boxes: [number, number, number, number, number][]
  /** What was read, masked: the first two characters and its length. */
  preview: string
  /** The crop the agent looks at, relative to the context folder. */
  crop: string
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4

/** Frame times to read: each scene's start, then every SAMPLE_EVERY_S, an idle stretch once; at most MAX_FRAMES. */
export function sampleTimes(a: Pick<Analysis, 'source' | 'idle' | 'scenes'>, max = MAX_FRAMES): number[] {
  const D = a.source.duration
  const idle = (t: number) => a.idle.find((s) => t > s.start + 0.2 && t < s.end)
  const times = new Set<number>([0.2, ...a.scenes.map((s) => Math.min(D - 0.05, s + 0.3))])
  for (let t = 0.2; t < D - 0.05; t += SAMPLE_EVERY_S) {
    const i = idle(t)
    times.add(i ? Math.min(D - 0.05, i.start + 0.2) : t)
  }
  let list = [...times].map(r4).sort((p, q) => p - q)
  // Too many: keep scene starts, thin the rest evenly.
  if (list.length > max) {
    const step = list.length / max
    list = Array.from({ length: max }, (_, i) => list[Math.floor(i * step)] as number)
  }
  return [...new Set(list)]
}

/** Matches on a frame's lines: a match's box is the union of the words it touches, padded, as frame fractions. */
export function matchFrame(
  lines: OcrFrame,
  opts: { patterns: boolean; strings: readonly string[]; width: number; height: number },
): Detection[] {
  const out: Detection[] = []
  for (const words of lines) {
    let text = ''
    const spans: [number, number][] = []
    for (const w of words) {
      if (text) text += ' '
      spans.push([text.length, text.length + w.text.length])
      text += w.text
    }
    for (const m of findPrivate(text, { patterns: opts.patterns, strings: opts.strings })) {
      const hit = words.filter((_, i) => {
        const [s, e] = spans[i] as [number, number]
        return s < m.end && e > m.start
      })
      if (!hit.length) continue
      const x0 = Math.max(0, Math.min(...hit.map((w) => w.x0)) - PAD_PX)
      const y0 = Math.max(0, Math.min(...hit.map((w) => w.y0)) - PAD_PX)
      const x1 = Math.min(opts.width, Math.max(...hit.map((w) => w.x1)) + PAD_PX)
      const y1 = Math.min(opts.height, Math.max(...hit.map((w) => w.y1)) + PAD_PX)
      out.push({
        kind: m.kind,
        text: m.text,
        box: [
          r4(x0 / opts.width),
          r4(y0 / opts.height),
          r4((x1 - x0) / opts.width),
          r4((y1 - y0) / opts.height),
        ],
      })
    }
  }
  return out
}

const overlap = (a: Detection['box'], b: Detection['box']) => {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]))
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
  const inter = ix * iy
  return inter / Math.max(1e-9, a[2] * a[3] + b[2] * b[3] - inter)
}

/**
 * Detections per sampled frame -> candidates. The same text read again in the next sampled frame, near where it was,
 * is the same candidate (a new key if it moved); its span reaches the frames either side where it wasn't read, so
 * the box is up before the text can show and stays until it must be gone.
 */
export function mergeDetections(
  frames: { t: number; found: Detection[] }[],
  duration: number,
): Omit<PrivacyCandidate, 'id' | 'crop'>[] {
  type Open = {
    kind: PrivacyKind
    text: string
    keys: [number, number, number, number, number][]
    first: number
    last: number
  }
  const done: Open[] = []
  let open: Open[] = []
  frames.forEach((f, i) => {
    const next: Open[] = []
    for (const d of f.found) {
      const prev = open.find(
        (o) => o.kind === d.kind && o.text.toLowerCase() === d.text.toLowerCase() && !next.includes(o),
      )
      const lastKey = prev?.keys.at(-1)
      if (prev && lastKey) {
        if (overlap([lastKey[1], lastKey[2], lastKey[3], lastKey[4]], d.box) < 0.6)
          prev.keys.push([f.t, ...d.box])
        prev.last = i
        next.push(prev)
      } else next.push({ kind: d.kind, text: d.text, keys: [[f.t, ...d.box]], first: i, last: i })
    }
    for (const o of open) if (!next.includes(o)) done.push(o)
    open = next
  })
  done.push(...open)
  const at = (i: number) => frames[i]?.t
  return done
    .map((o) => {
      const before = at(o.first - 1)
      const after = at(o.last + 1)
      const start = r4(before ?? 0)
      const end = r4(after ?? duration)
      // The first key starts with the span, so the box is up as soon as the area is.
      const keys = o.keys.map((k, j) => (j === 0 ? ([start, k[1], k[2], k[3], k[4]] as typeof k) : k))
      return {
        kind: o.kind,
        reason: `Privacy mode: ${PRIVACY_LABELS[o.kind]}`,
        start,
        end,
        boxes: keys,
        preview: `${o.text.slice(0, 2)}… (${String(o.text.length)} characters)`,
      }
    })
    .sort((p, q) => p.start - q.start)
}

/** tesseract.js with the bundled English data (no network), one worker for every frame. */
export async function tesseractOcr(): Promise<{ ocr: Ocr; close: () => Promise<void> }> {
  const { createWorker } = await import('tesseract.js')
  const req = createRequire(import.meta.url)
  const langPath = join(dirname(req.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int')
  const worker = await createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true })
  return {
    ocr: async (png) => {
      const r = await worker.recognize(png, {}, { blocks: true })
      return (r.data.blocks ?? []).flatMap((b) =>
        b.paragraphs.flatMap((p) =>
          p.lines.map((l) =>
            l.words.map((w) => ({
              text: w.text,
              x0: w.bbox.x0,
              y0: w.bbox.y0,
              x1: w.bbox.x1,
              y1: w.bbox.y1,
            })),
          ),
        ),
      )
    },
    close: async () => {
      await worker.terminate()
    },
  }
}

const frameAt = (file: string, t: number, out: string) =>
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', out])
    .status === 0

/**
 * Reads the recording and writes context/recording/<id>/privacy/candidates.json and a crop per candidate. Returns the
 * candidates and what the scan cost.
 */
export async function scanPrivacy(
  file: string,
  a: Analysis,
  opts: { patterns: boolean; strings: readonly string[]; contextDir: string; ocr?: Ocr; budgetMs?: number },
) {
  const started = Date.now()
  const dir = join(opts.contextDir, 'privacy')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'frames'), { recursive: true })
  const own = opts.ocr ? null : await tesseractOcr()
  const ocr = opts.ocr ?? (own as { ocr: Ocr }).ocr
  const times = sampleTimes(a)
  const frames: { t: number; found: Detection[] }[] = []
  let stopped = false
  try {
    for (const t of times) {
      if (Date.now() - started > (opts.budgetMs ?? BUDGET_MS)) {
        stopped = true
        break
      }
      const png = join(dir, 'frames', `${t.toFixed(2)}.png`)
      if (!frameAt(file, t, png)) continue
      const found = matchFrame(await ocr(png), {
        patterns: opts.patterns,
        strings: opts.strings,
        width: a.source.width,
        height: a.source.height,
      })
      frames.push({ t, found })
    }
  } finally {
    await own?.close()
  }
  const candidates: PrivacyCandidate[] = mergeDetections(frames, a.source.duration).map((c, i) => {
    const id = `p${String(i + 1)}`
    const k = c.boxes[0] as [number, number, number, number, number]
    // The crop: the box with some room around it, at the first frame it was read in.
    const pad = 0.04
    const [x, y, w, h] = [
      Math.max(0, k[1] - pad),
      Math.max(0, k[2] - pad),
      Math.min(1, k[3] + 2 * pad),
      Math.min(1, k[4] + 2 * pad),
    ]
    const W = a.source.width
    const H = a.source.height
    const crop = `privacy/${id}.jpg`
    const seen = frames.find((f) => f.found.length && f.t >= c.start)?.t ?? c.start
    spawnSync('ffmpeg', [
      ...['-loglevel', 'error', '-y', '-ss', seen.toFixed(3), '-i', file, '-frames:v', '1'],
      ...[
        '-vf',
        `crop=${String(Math.round(w * W))}:${String(Math.round(h * H))}:${String(Math.round(x * W))}:${String(Math.round(y * H))}`,
      ],
      ...['-q:v', '3', join(opts.contextDir, crop)],
    ])
    return { id, ...c, crop }
  })
  rmSync(join(dir, 'frames'), { recursive: true, force: true })
  const result = {
    v: 1 as const,
    patterns: opts.patterns,
    strings: opts.strings.length,
    frames: frames.length,
    sampled: times.length,
    stopped,
    ms: Date.now() - started,
    candidates,
  }
  writeFileSync(join(dir, 'candidates.json'), `${JSON.stringify(result, null, 2)}\n`)
  log('recording.privacy_scan', { ...result, candidates: candidates.length })
  return result
}

/**
 * The output check (render-job): OCR of the rendered video, a frame a second (at most MAX_FRAMES, within the budget).
 * A hide string still readable is a problem the run must fix; a privacy pattern is reported, since the agent may have
 * judged it not private.
 */
export async function checkOutputPrivacy(
  video: string,
  info: { width: number; height: number; duration: number },
  opts: { patterns: boolean; strings: readonly string[]; workDir: string; ocr?: Ocr; budgetMs?: number },
) {
  const started = Date.now()
  mkdirSync(opts.workDir, { recursive: true })
  const own = opts.ocr ? null : await tesseractOcr()
  const ocr = opts.ocr ?? (own as { ocr: Ocr }).ocr
  const step = Math.max(1, info.duration / MAX_FRAMES)
  const readable: { t: number; kind: PrivacyKind }[] = []
  const noted: { t: number; kind: PrivacyKind }[] = []
  let frames = 0
  let stopped = false
  try {
    for (let t = 0.5; t < info.duration; t += step) {
      if (Date.now() - started > (opts.budgetMs ?? BUDGET_MS)) {
        stopped = true
        break
      }
      const png = join(opts.workDir, `out-${t.toFixed(2)}.png`)
      if (!frameAt(video, t, png)) continue
      frames++
      for (const d of matchFrame(await ocr(png), { ...opts, width: info.width, height: info.height }))
        (d.kind === 'string' ? readable : noted).push({ t: r4(t), kind: d.kind })
    }
  } finally {
    await own?.close()
    rmSync(opts.workDir, { recursive: true, force: true })
  }
  const result = { frames, ms: Date.now() - started, stopped, readable, noted }
  log('render.privacy_check', { ...result, readable: readable.length, noted: noted.length })
  return result
}
