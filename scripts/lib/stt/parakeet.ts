// The local provider (docs/spikes.md S11): NVIDIA Parakeet TDT 0.6B v3 (int8, sherpa-onnx, CC-BY-4.0) through
// HyperFrames. `hyperframes models install parakeet` is idempotent and caches the model in ~/.cache/hyperframes
// (704 MB, 3.4 s on the runner); `hyperframes transcribe --engine parakeet --json --dir <d>` writes
// <d>/transcript.json, one { id, text, start, end } per word in seconds. About 0.06x real time on 10 minutes.
// v3 is multilingual (25 European languages, src/lib/language.ts PARAKEET_LANGUAGES) and detects the language itself:
// HyperFrames uses --language only to refuse one it doesn't cover (runStt checks that first).
// Both commands run under the caller's outer deadline with the whole process tree killed on timeout (proc-tree.ts):
// HyperFrames' own --timeout only covers its Whisper engine.
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runTree, type TreeOptions, type TreeResult } from '../proc-tree.js'
import { remaining, SttTimeout, type SttProvider, type SttWord } from './types.js'

export const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3-int8'

/**
 * S11 measured Parakeet's phrase starts consistently ~236-240 ms early (reported before the true onset), and its
 * phrase ends 430-485 ms late. So captions add a fixed 240 ms to every word's start and leave its end alone, keeping
 * each word at least WORD_MIN_S long. Median start error after it: 34-48 ms. Re-measure (docs/spikes/s11) when the model
 * changes.
 */
export const PARAKEET_OFFSET_S = 0.24
export const WORD_MIN_S = 0.05

type Run = (cmd: string, args: string[], opts: TreeOptions) => Promise<TreeResult>

/** hyperframes transcript.json: [{ id, text, start, end }] in seconds; entries without text or times are dropped. */
export function parseHyperframesTranscript(json: unknown): SttWord[] {
  if (!Array.isArray(json)) throw new Error('transcript.json is not an array')
  return json
    .filter((w): w is { text: string; start: number; end: number } => {
      const o = (w ?? {}) as Record<string, unknown>
      return (
        typeof o.text === 'string' &&
        typeof o.start === 'number' &&
        typeof o.end === 'number' &&
        Number.isFinite(o.start) &&
        Number.isFinite(o.end)
      )
    })
    .map((w) => ({ text: w.text.trim(), start: w.start, end: Math.max(w.start, w.end) }))
    .filter((w) => w.text.length > 0)
}

const ms3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * The fixed offset correction: `offset` seconds later starts, ends as reported but at least WORD_MIN_S after the
 * start; rounded to the millisecond. A word reported at 1.00-1.30 s is captioned at 1.24-1.30 s.
 */
export function correctOffset(words: SttWord[], offset = PARAKEET_OFFSET_S): SttWord[] {
  return words.map((w) => {
    const start = ms3(Math.max(0, w.start + offset))
    return { text: w.text, start, end: ms3(Math.max(w.end, start + WORD_MIN_S)) }
  })
}

const failure = (what: string, r: TreeResult) => {
  if (r.timedOut) return new SttTimeout(`${what} ran past the transcription deadline and was stopped.`)
  const tail = r.stderrTail.trim().split('\n').slice(-4).join(' ').slice(-500)
  return new Error(`${what} failed (${r.signal ?? `exit ${r.code}`})${tail ? `: ${tail}` : ''}`)
}

export function parakeet(run: Run = runTree): SttProvider {
  return {
    name: 'local',
    model: PARAKEET_MODEL,
    async transcribe(wav, opts) {
      const started = Date.now()
      const install = await run('npx', ['-y', 'hyperframes', 'models', 'install', 'parakeet', '--json'], {
        cwd: opts.cwd,
        deadlineMs: remaining(opts.deadlineAt),
      })
      if (!install.ok) throw failure('Installing Parakeet', install)
      const dir = join(opts.workDir, 'parakeet')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const r = await run(
        'npx',
        [
          '-y',
          'hyperframes',
          'transcribe',
          wav,
          '--engine',
          'parakeet',
          '--language',
          opts.language,
          '--dir',
          dir,
          '--json',
        ],
        { cwd: opts.cwd, deadlineMs: remaining(opts.deadlineAt) },
      )
      if (!r.ok) throw failure('Parakeet transcription', r)
      const words = parseHyperframesTranscript(JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8')))
      return {
        words: correctOffset(words),
        provider: 'local',
        model: PARAKEET_MODEL,
        durationMs: Date.now() - started,
      }
    },
  }
}
