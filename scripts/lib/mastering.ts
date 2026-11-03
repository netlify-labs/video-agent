// Mastering a narrated render (plan 2026-11-02 §6.3 step 7, docs/spikes.md S12). A trusted final-mix transform,
// separate from the locked narration PCM: render-job measures the rendered MP4's decoded AAC with ffmpeg ebur128 and,
// when the mix is off -14 +/- 1 LUFS, applies one master gain to the summed mix by re-encoding only the audio stream
// (the video packets are copied, and checked byte-identical by their framemd5). Peak first: the true peak stays at or
// under -1 dBTP, and when the target loudness can't be reached under it the measured LUFS is kept with a warning.
// Silent and speechless mixes are left alone. HTML volumes are never edited, so checkNarration's exact transform holds.
// Also the automation cap: HyperFrames silently keeps only the first 512 points of a lane (S12), so render-job fails
// any lane over MAX_AUTOMATION_POINTS before rendering.
import { spawnSync } from 'node:child_process'
import { renameSync, rmSync } from 'node:fs'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { Loudness, MasteringReport } from '../../src/domain/types.js'
import { MAX_DUCK_POINTS, NARRATION_ID } from '../../src/lib/contract.js'
import { ebur128 } from './narration-cleanup.js'
import { StepError } from './run-tools.js'

export const MASTER = {
  targetLufs: -14,
  toleranceLu: 1,
  ceilingDbtp: -1,
  /** Head room under the ceiling for the AAC re-encode's own overshoot (S12). */
  marginDb: 0.2,
  /** Integrated loudness under this is a silent mix: no gain. */
  silentLufs: -50,
} as const

/** The most points one automation lane may carry: the duck lane's own cap, well under HyperFrames' silent 512. */
export const MAX_AUTOMATION_POINTS = MAX_DUCK_POINTS
/** What HyperFrames itself keeps of a lane (docs/spikes.md S12): the cap for compositions without narration. */
export const HYPERFRAMES_AUTOMATION_POINTS = 512

const r2 = (n: number) => Math.round(n * 100) / 100

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
function* elements(n: Node): Generator<Element> {
  if ('tagName' in n) yield n
  if ('childNodes' in n) for (const c of n.childNodes) yield* elements(c)
  if ('content' in n) yield* elements(n.content)
}
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value ?? null

/** Every automation lane in `html` with more than `cap` points (unreadable lanes are check's job). */
export function automationOverCap(
  html: string,
  cap = MAX_AUTOMATION_POINTS,
): { element: string; target: string; points: number }[] {
  const out: { element: string; target: string; points: number }[] = []
  for (const e of elements(parse(html))) {
    const raw = attr(e, 'data-automation')
    if (!raw) continue
    let a: { lanes?: { target?: unknown; points?: unknown }[] }
    try {
      a = JSON.parse(raw) as typeof a
    } catch {
      continue
    }
    for (const l of Array.isArray(a.lanes) ? a.lanes : [])
      if (Array.isArray(l.points) && l.points.length > cap)
        out.push({
          element: attr(e, 'id') ?? e.tagName,
          target: typeof l.target === 'string' ? l.target : '?',
          points: l.points.length,
        })
  }
  return out
}

/**
 * Whether the composition carries recorded narration (the bus layer), and whether that narration has any speech
 * (its data-va-speech isn't empty). Only narrated compositions are mastered, so other videos render as before.
 */
export function narrationOf(html: string): { narrated: boolean; speech: boolean } {
  for (const e of elements(parse(html))) {
    if (e.tagName !== 'audio' || attr(e, 'id') !== NARRATION_ID) continue
    let spans: unknown
    try {
      spans = JSON.parse(attr(e, 'data-va-speech') ?? '[]')
    } catch {
      spans = []
    }
    return { narrated: true, speech: Array.isArray(spans) && spans.length > 0 }
  }
  return { narrated: false, speech: false }
}

/** The decoded audio's integrated loudness and true peak. */
export const measure = (video: string, ffmpeg = 'ffmpeg'): Loudness => {
  const m = ebur128(video, ffmpeg)
  return {
    integratedLufs: m.integratedLufs === null ? null : r2(m.integratedLufs),
    truePeakDb: r2(m.truePeakDb),
  }
}

/**
 * The one master gain for a measured mix, peak first. Exempt: silent (under MASTER.silentLufs, or -inf) or no speech.
 * Within target: -14 +/- 1 LUFS with the true peak at or under the ceiling. Otherwise the gain toward -14, capped so
 * the peak lands MASTER.marginDb under the ceiling (peak_limited when that leaves it short of the window).
 */
export function planGain(
  before: Loudness,
  o: { speech: boolean },
): Omit<MasteringReport, 'after' | 'before'> {
  const lufs = before.integratedLufs
  if (lufs === null || lufs < MASTER.silentLufs) return { status: 'exempt', gainDb: 0, warnings: ['silent'] }
  if (!o.speech) return { status: 'exempt', gainDb: 0, warnings: ['no_speech'] }
  const want = MASTER.targetLufs - lufs
  if (Math.abs(want) <= MASTER.toleranceLu && before.truePeakDb <= MASTER.ceilingDbtp)
    return { status: 'within_target', gainDb: 0, warnings: [] }
  const room = MASTER.ceilingDbtp - MASTER.marginDb - before.truePeakDb
  const gainDb = r2(Math.min(want, room))
  const warnings =
    lufs + gainDb < MASTER.targetLufs - MASTER.toleranceLu
      ? [
          `peak_limited: ${r2(lufs + gainDb)} LUFS is the loudest the mix gets with its true peak at ${MASTER.ceilingDbtp} dBTP`,
        ]
      : []
  return { status: 'mastered', gainDb, warnings }
}

function ff(bin: string, args: string[]): { stdout: string; stderr: string } {
  const r = spawnSync(bin, ['-hide_banner', '-nostdin', '-nostats', ...args], {
    encoding: 'utf8',
    timeout: 10 * 60_000,
    maxBuffer: 256 * 1024 * 1024,
  })
  if (r.status !== 0)
    throw new StepError(`${bin} failed: ${(r.stderr || r.error?.message || '').trim().slice(-1500)}`)
  return { stdout: r.stdout, stderr: r.stderr }
}

/** Per-packet md5 of the first video stream, copied without decoding (pts, dts, size and hash per packet). */
export const videoPackets = (video: string, ffmpeg = 'ffmpeg') =>
  ff(ffmpeg, ['-loglevel', 'error', '-i', video, '-map', '0:v:0', '-c', 'copy', '-f', 'framemd5', '-'])
    .stdout.split('\n')
    .filter((l) => l && !l.startsWith('#'))

/** The first audio stream's rate, channels and bit rate, so the re-encode keeps them. */
function audioFormat(video: string, ffprobe: string) {
  const r = spawnSync(
    ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=sample_rate,channels,bit_rate',
      '-of',
      'json',
      video,
    ],
    { encoding: 'utf8' },
  )
  const s =
    (JSON.parse(r.stdout || '{}') as { streams?: Record<string, string | number>[] }).streams?.[0] ?? {}
  return {
    sampleRate: Number(s.sample_rate) || 48_000,
    channels: Number(s.channels) || 2,
    bitRate: Number(s.bit_rate) > 0 ? Number(s.bit_rate) : 192_000,
  }
}

/** S12's re-mux: the video stream copied, the audio decoded, gained and re-encoded as AAC in the same format. */
export function remuxAudioGain(
  input: string,
  output: string,
  gainDb: number,
  o: { ffmpeg?: string; ffprobe?: string } = {},
) {
  const a = audioFormat(input, o.ffprobe ?? 'ffprobe')
  ff(o.ffmpeg ?? 'ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-map_metadata',
    '0',
    '-c:v',
    'copy',
    '-af',
    `volume=${gainDb.toFixed(2)}dB`,
    '-c:a',
    'aac',
    '-b:a',
    String(a.bitRate),
    '-ar',
    String(a.sampleRate),
    '-ac',
    String(a.channels),
    '-movflags',
    '+faststart',
    output,
  ])
}

/**
 * Measures `video` and, when the plan says so, masters it in place (a temp file renamed over it). A re-encode that
 * overshoots the ceiling is redone once from the original with the overshoot (plus 0.1 dB) taken off, as in S12.
 * Throws a StepError if the video packets changed: the picture must be exactly what HyperFrames rendered.
 */
export function master(
  video: string,
  o: { speech: boolean; ffmpeg?: string; ffprobe?: string },
): MasteringReport {
  const ffmpeg = o.ffmpeg ?? 'ffmpeg'
  const before = measure(video, ffmpeg)
  const plan = planGain(before, o)
  if (plan.status !== 'mastered') return { ...plan, before, after: null }
  const tmp = `${video}.mastered.mp4`
  let gainDb = plan.gainDb
  try {
    remuxAudioGain(video, tmp, gainDb, o)
    let after = measure(tmp, ffmpeg)
    if (after.truePeakDb > MASTER.ceilingDbtp) {
      gainDb = r2(gainDb - (after.truePeakDb - MASTER.ceilingDbtp + 0.1))
      remuxAudioGain(video, tmp, gainDb, o)
      after = measure(tmp, ffmpeg)
    }
    // The measured loudness, not the planned one: the re-encode and a second pass move it a little.
    const warnings = plan.warnings.map((w) =>
      w.startsWith('peak_limited')
        ? `peak_limited: ${after.integratedLufs} LUFS measured with the true peak at ${after.truePeakDb} dBTP (target ${MASTER.targetLufs} +/- ${MASTER.toleranceLu})`
        : w,
    )
    if (after.truePeakDb > MASTER.ceilingDbtp) warnings.push(`true_peak_over: ${after.truePeakDb} dBTP`)
    if (
      !plan.warnings.length &&
      (after.integratedLufs === null ||
        Math.abs(after.integratedLufs - MASTER.targetLufs) > MASTER.toleranceLu)
    )
      warnings.push(`loudness_off_target: ${after.integratedLufs} LUFS after the master gain`)
    const was = videoPackets(video, ffmpeg)
    const now = videoPackets(tmp, ffmpeg)
    if (was.length === 0 || was.length !== now.length || was.some((l, i) => l !== now[i]))
      throw new StepError(
        'Mastering changed the video stream; it may only re-encode the audio. Stop and report this.',
      )
    renameSync(tmp, video)
    return { status: 'mastered', before, after, gainDb, warnings }
  } finally {
    rmSync(tmp, { force: true })
  }
}
