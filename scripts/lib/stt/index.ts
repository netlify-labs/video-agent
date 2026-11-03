// The STT stage of a narration run (plan 2026-11-02 §6.6, bead va-2qq.3.12), after scripts/narration.ts wrote the bus:
//   1. pick    the provider the render froze (NarrationInputs.transcriptionProvider, default 'local'); 'off' or muted
//              narration skips; 'elevenlabs' without ELEVENLABS_API_KEY falls back to the local provider, with a warning
//   2. cache   ~/.cache/video-agent/stt/<bus sha256>-<provider>-<model>-<language>.json. Runner caches don't outlive a
//              run, so across runs this is a no-op on a fresh runner; it saves a retry within one
//   3. decode  video/assets/narration/bus.wav to 16 kHz mono PCM16 (.va-run/narration/stt/bus16k.wav)
//   4. run     the provider under one outer deadline (STT_DEADLINE_MS) covering decode, install, model download and
//              transcription; on timeout the whole process tree is killed (scripts/lib/proc-tree.ts)
//   5. write   .va-run/narration/stt.json (SttRecord, with the words) and `stt` in receipt.json (without them)
// It never throws for a transcription problem: STT must not block the render, so a failure is a status the run
// carries on with (captions then fall back, scripts/lib/narration-captions.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NARRATION_SRC } from '../../../src/lib/contract.js'
import type { FrozenTranscription } from '../../../src/lib/run-manifest.js'
import { narrationPaths, readNarrationInputs } from '../narration-inputs.js'
import { runTree } from '../proc-tree.js'
import { log, sha256File } from '../run-tools.js'
import { scribe } from './elevenlabs.js'
import { PARAKEET_OFFSET_S, parakeet } from './parakeet.js'
import { remaining, SttTimeout, type SttProvider, type SttProviderName, type SttWord } from './types.js'

export * from './types.js'

/**
 * Outer deadline for the whole stage. S11: 10 minutes of narration took ~36 s plus a 3.4 s install on the runner,
 * so 180 s leaves room for a cold model download inside the 22-minute run.
 */
export const STT_DEADLINE_MS = 180_000

export const STT_RECORD_VERSION = 1

export type SttStatus = 'ok' | 'failed' | 'off' | 'timeout'

/** .va-run/narration/stt.json. The receipt's `stt` is the same without `words`, plus their count. */
export interface SttRecord {
  v: typeof STT_RECORD_VERSION
  status: SttStatus
  /** The admin setting the render froze. */
  setting: FrozenTranscription
  /** Who transcribed (null when skipped or failed before a provider was chosen). */
  provider: SttProviderName | null
  model: string | null
  language: 'en'
  /** The bus transcribed (sha256 of video/assets/narration/bus.wav). */
  busSha256: string | null
  /** Composition seconds, offset-corrected (local: PARAKEET_OFFSET_S off start and end). Empty unless ok. */
  words: SttWord[]
  offsetMs: number
  /** The stage's wall time, decode included (a cache hit is just the lookup). */
  durationMs: number
  cached: boolean
  error?: string
  warnings: string[]
}

export type SttReceipt = Omit<SttRecord, 'words'> & { words: number }

export const sttCacheDir = () => join(homedir(), '.cache', 'video-agent', 'stt')

/** The provider for a setting, or null for 'off'. */
export function pickSttProvider(
  setting: FrozenTranscription,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): { provider: SttProvider | null; warnings: string[] } {
  if (setting === 'off') return { provider: null, warnings: [] }
  if (setting === 'elevenlabs') {
    if (env.ELEVENLABS_API_KEY) return { provider: scribe(env.ELEVENLABS_API_KEY, fetchImpl), warnings: [] }
    return {
      provider: parakeet(),
      warnings: [
        'Transcription is set to ElevenLabs but ELEVENLABS_API_KEY is not set; used the local provider.',
      ],
    }
  }
  return { provider: parakeet(), warnings: [] }
}

export interface RunSttOptions {
  root: string
  ffmpeg?: string
  env?: NodeJS.ProcessEnv
  deadlineMs?: number
  cacheDir?: string
  /** Tests: the provider to use instead of pickSttProvider's. */
  provider?: SttProvider | null
}

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000)

/** Runs the stage over the prepared workspace at `root` and writes stt.json and the receipt's `stt`. */
export async function runStt(o: RunSttOptions): Promise<SttRecord> {
  const started = Date.now()
  const deadlineAt = started + (o.deadlineMs ?? STT_DEADLINE_MS)
  const p = narrationPaths(o.root)
  const inputs = readNarrationInputs(o.root)
  const setting: FrozenTranscription = inputs?.transcriptionProvider ?? 'local'
  const record: SttRecord = {
    v: STT_RECORD_VERSION,
    status: 'failed',
    setting,
    provider: null,
    model: null,
    language: 'en',
    busSha256: null,
    words: [],
    offsetMs: 0,
    durationMs: 0,
    cached: false,
    warnings: [],
  }
  const finish = (status: SttStatus, fields: Partial<SttRecord> = {}): SttRecord => {
    Object.assign(record, fields, { status, durationMs: Date.now() - started })
    if (status !== 'ok') record.words = []
    writeRecord(o.root, record)
    log('stt.done', {
      status,
      provider: record.provider,
      model: record.model,
      words: record.words.length,
      ms: record.durationMs,
      cached: record.cached,
      ...(record.error ? { error: record.error } : {}),
    })
    return record
  }

  if (!inputs)
    return finish('failed', { error: `${p.manifest} is missing: this run has no recorded narration.` })
  if (setting === 'off') return finish('off')
  if (inputs.op.tracks.narration.muted)
    return finish('off', { warnings: ['The narration track is muted, so it was not transcribed.'] })
  const bus = join(o.root, 'video', NARRATION_SRC)
  if (!existsSync(bus))
    return finish('failed', { error: `video/${NARRATION_SRC} is missing. Run narration.ts first.` })
  const picked =
    o.provider !== undefined
      ? { provider: o.provider, warnings: [] }
      : pickSttProvider(setting, o.env ?? process.env)
  record.warnings.push(...picked.warnings)
  const provider = picked.provider
  if (!provider) return finish('off')
  record.provider = provider.name
  record.model = provider.model
  record.offsetMs = provider.name === 'local' ? -Math.round(PARAKEET_OFFSET_S * 1000) : 0
  record.busSha256 = sha256File(bus)

  // Cache.
  const cacheDir = o.cacheDir ?? sttCacheDir()
  const cacheFile = join(
    cacheDir,
    `${record.busSha256}-${provider.name}-${provider.model}-${record.language}.json`,
  )
  try {
    const hit = JSON.parse(readFileSync(cacheFile, 'utf8')) as { words?: SttWord[] }
    if (Array.isArray(hit.words)) {
      log('stt.cache', { hit: true, file: cacheFile })
      return finish('ok', { words: hit.words, cached: true })
    }
  } catch {
    log('stt.cache', { hit: false })
  }

  try {
    // Decode under the same deadline.
    const work = join(p.dir, 'stt')
    mkdirSync(work, { recursive: true })
    const wav16k = join(work, 'bus16k.wav')
    const t0 = Date.now()
    const d = await runTree(
      o.ffmpeg ?? process.env.FFMPEG ?? 'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-i',
        bus,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        wav16k,
      ],
      { cwd: o.root, deadlineMs: remaining(deadlineAt) },
    )
    if (d.timedOut) throw new SttTimeout('Decoding the bus ran past the transcription deadline.')
    if (!d.ok) throw new Error(`Decoding the bus to 16 kHz failed: ${d.stderrTail.trim().slice(-300)}`)
    log('stt.decode', { ms: Date.now() - t0 })

    const out = await provider.transcribe(wav16k, {
      deadlineAt,
      workDir: work,
      cwd: join(o.root, 'video'),
      language: 'en',
    })
    log('stt.transcribe', {
      provider: out.provider,
      model: out.model,
      words: out.words.length,
      ms: out.durationMs,
    })
    try {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({ words: out.words }))
    } catch (e) {
      log('stt.cache_write_skipped', { error: errorOf(e) })
    }
    return finish('ok', { words: out.words, model: out.model })
  } catch (e) {
    return finish(e instanceof SttTimeout || Date.now() >= deadlineAt ? 'timeout' : 'failed', {
      error: errorOf(e),
    })
  }
}

/** stt.json, and the receipt's `stt` when narration.ts wrote one. */
function writeRecord(root: string, record: SttRecord) {
  const p = narrationPaths(root)
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.stt, JSON.stringify(record, null, 2))
  if (!existsSync(p.receipt)) return
  const receipt = JSON.parse(readFileSync(p.receipt, 'utf8')) as Record<string, unknown>
  receipt.stt = { ...record, words: record.words.length } satisfies SttReceipt
  writeFileSync(p.receipt, JSON.stringify(receipt, null, 2))
}

/** The stage's record, or null when it hasn't run. */
export function readSttRecord(root: string): SttRecord | null {
  const p = narrationPaths(root).stt
  if (!existsSync(p)) return null
  try {
    const r = JSON.parse(readFileSync(p, 'utf8')) as { v?: unknown }
    return r.v === STT_RECORD_VERSION ? (r as SttRecord) : null
  } catch {
    return null
  }
}
