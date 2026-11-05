// recording.ts analyze, the extras (screen-recording plan §5.2; va-rsk5.3.2): contact sheets the agent looks at, an
// on-device transcript when the recording has speech, and the analysis cache.
// - Sheets: one per scene (at most 24), 12 frames evenly spaced, tiled 4x3 into a 1280-wide JPEG (q80), at
//   context/recording/<id>/sheets/NN.jpg. Each frame's time is in sheets.json next to them (not burned in: the
//   runner's static ffmpeg may lack drawtext).
// - Transcript: when the file has an audio track that isn't silent, Parakeet (on device, scripts/lib/stt/parakeet.ts)
//   writes word timings to context/recording/<id>/transcript.json. The audio itself never reaches the video (§8).
// - Cache: analysis.json is reused when its sha256 and analyzer match the file and ANALYZER_VERSION; only the
//   sheets are made again. context/ never enters a checkpoint or source archive (they tar video/ only).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANALYZER_VERSION, type Analysis } from './recording-analyze.js'
import { log } from './run-tools.js'
import type { SttProvider, SttWord } from './stt/types.js'

export const SHEETS_MAX = 24
const SHEET_FRAMES = 12
const SHEET_WIDTH = 1280
/** Below this mean volume (dBFS) an audio track counts as silent. */
const SPEECH_MIN_DB = -45

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** The cached analysis for this file, or null when there's none or it's stale (other bytes, other analyzer). */
export function cachedAnalysis(path: string, fileSha256: string): Analysis | null {
  if (!existsSync(path)) return null
  try {
    const a = JSON.parse(readFileSync(path, 'utf8')) as Analysis
    return a.sha256 === fileSha256 && a.analyzer === ANALYZER_VERSION ? a : null
  } catch {
    return null
  }
}

/** The scenes as spans: from 0 to each scene change to the end, dropping slivers under half a second. */
export function sceneSpans(a: Pick<Analysis, 'scenes' | 'source'>): [number, number][] {
  const cuts = [0, ...a.scenes.filter((t) => t > 0 && t < a.source.duration), a.source.duration]
  const spans: [number, number][] = []
  for (let i = 1; i < cuts.length; i++) {
    const s = cuts[i - 1] ?? 0
    const e = cuts[i] ?? 0
    if (e - s >= 0.5) spans.push([s, e])
  }
  return spans.slice(0, SHEETS_MAX)
}

/** Contact sheets for each scene; returns what sheets.json records. */
export function makeSheets(file: string, a: Analysis, dir: string) {
  const started = Date.now()
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tile = SHEET_WIDTH / 4
  const sheets = sceneSpans(a).map(([s, e], i) => {
    const times = Array.from({ length: SHEET_FRAMES }, (_, k) => r3(s + ((e - s) * (k + 0.5)) / SHEET_FRAMES))
    const frames = times.map((t, k) => {
      const out = join(dir, `.f${i}-${k}.jpg`)
      const r = spawnSync('ffmpeg', [
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(t),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `scale=${tile}:-2`,
        '-q:v',
        '3',
        out,
      ])
      if (r.status !== 0) throw new Error(`ffmpeg frame at ${t}: ${r.stderr.toString().slice(-300)}`)
      return out
    })
    const name = `${String(i + 1).padStart(2, '0')}.jpg`
    const inputs = frames.flatMap((f) => ['-i', f])
    const r = spawnSync('ffmpeg', [
      ...['-loglevel', 'error', '-y', ...inputs],
      ...[
        '-filter_complex',
        `${frames.map((_, k) => `[${k}:v]`).join('')}concat=n=${frames.length}:v=1:a=0,tile=4x3`,
      ],
      // q 5 is about JPEG quality 80.
      ...['-frames:v', '1', '-q:v', '5', join(dir, name)],
    ])
    if (r.status !== 0) throw new Error(`ffmpeg tile: ${r.stderr.toString().slice(-300)}`)
    for (const f of frames) rmSync(f, { force: true })
    return { file: name, scene: [r3(s), r3(e)] as [number, number], times }
  })
  writeFileSync(
    join(dir, 'sheets.json'),
    `${JSON.stringify({ v: 1, columns: 4, rows: 3, sheets }, null, 2)}\n`,
  )
  log('recording.sheets', { sheets: sheets.length, ms: Date.now() - started })
  return sheets
}

/** The audio track's mean volume in dBFS, or null without one. */
export function meanVolume(file: string): number | null {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  )
  if (!probe.stdout.trim()) return null
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  )
  const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr)
  return m ? Number(m[1]) : null
}

/**
 * The transcript, when the file's audio has sound in it: word timings from the provider (Parakeet on device), written
 * to `out`. Returns the words, or null when there's no audio or it's silent (no file is written then).
 */
export async function transcribeRecording(
  file: string,
  out: string,
  stt: SttProvider,
  opts: { workDir: string; cwd: string; deadlineAt: number },
): Promise<SttWord[] | null> {
  const started = Date.now()
  rmSync(out, { force: true })
  const volume = meanVolume(file)
  if (volume === null || volume < SPEECH_MIN_DB) {
    log('recording.transcript', { skipped: volume === null ? 'no audio' : 'silent', meanVolumeDb: volume })
    return null
  }
  mkdirSync(opts.workDir, { recursive: true })
  const wav = join(opts.workDir, 'speech.wav')
  const r = spawnSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '16000',
    wav,
  ])
  if (r.status !== 0) throw new Error(`ffmpeg audio: ${r.stderr.toString().slice(-300)}`)
  const result = await stt.transcribe(wav, { ...opts, language: 'en' })
  writeFileSync(
    out,
    `${JSON.stringify({ v: 1, provider: result.provider, model: result.model, words: result.words })}\n`,
  )
  log('recording.transcript', { words: result.words.length, meanVolumeDb: volume, ms: Date.now() - started })
  return result.words
}
