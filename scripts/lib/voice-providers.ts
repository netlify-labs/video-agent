// Voice providers for scripts/voice.ts (docs/spikes.md S9). Kokoro runs on the runner through `npx hyperframes tts` and is
// installed on first use; ElevenLabs is used when the deployer set ELEVENLABS_API_KEY and returns word times.
// The Netlify AI Gateway has no speech endpoint yet, so it isn't a provider here.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_KOKORO_VOICE,
  KOKORO_VOICE,
  SAMPLE_RATE,
  wordsFromCharacters,
  type Speech,
  type VoiceProvider,
} from '../../src/lib/voice.js'
import { StepError, log, run } from './run-tools.js'

const DEFAULT_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM'

/** Installs kokoro-onnx for the user once per run; a run without a voice-over never pays for it. */
function ensureKokoro() {
  try {
    run('python3', ['-c', 'import kokoro_onnx, soundfile'], { timeoutMs: 60_000 })
    return
  } catch {
    // Not installed yet.
  }
  const started = Date.now()
  const base = ['-m', 'pip', 'install', '--user', '--quiet', 'kokoro-onnx', 'soundfile']
  try {
    run('python3', base, { timeoutMs: 5 * 60_000 })
  } catch {
    run('python3', [...base, '--break-system-packages'], { timeoutMs: 5 * 60_000 })
  }
  log('voice.kokoro_installed', { ms: Date.now() - started })
}

export function kokoro(cwd: string): VoiceProvider {
  let ready = false
  return {
    name: 'kokoro',
    synthesize(text, opts) {
      if (!ready) {
        ensureKokoro()
        ready = true
      }
      const dir = mkdtempSync(join(tmpdir(), 'va-tts-'))
      try {
        // The text goes in a file, so nothing in it reaches a shell or an argument parser.
        writeFileSync(join(dir, 'line.txt'), text)
        const out = join(dir, 'line.wav')
        run(
          'npx',
          [
            'hyperframes',
            'tts',
            join(dir, 'line.txt'),
            '-o',
            out,
            '--voice',
            opts.voice,
            '--speed',
            String(opts.speed),
            '--json',
          ],
          { cwd, timeoutMs: 5 * 60_000 },
        )
        return Promise.resolve({ audio: new Uint8Array(readFileSync(out)), format: 'wav' })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

export function elevenlabs(apiKey: string, fetchImpl: typeof fetch = fetch): VoiceProvider {
  return {
    name: 'elevenlabs',
    async synthesize(text, opts) {
      const res = await fetchImpl(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voice)}/with-timestamps?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { speed: Math.min(1.2, Math.max(0.7, opts.speed)) },
          }),
          signal: AbortSignal.timeout(120_000),
        },
      )
      const body = (await res.json().catch(() => ({}))) as {
        audio_base64?: string
        alignment?: {
          characters?: string[]
          character_start_times_seconds?: number[]
          character_end_times_seconds?: number[]
        }
        detail?: { message?: string } | string
      }
      if (!res.ok || !body.audio_base64) {
        const detail = typeof body.detail === 'string' ? body.detail : body.detail?.message
        throw new StepError(`ElevenLabs returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`)
      }
      const a = body.alignment
      const speech: Speech = {
        audio: new Uint8Array(Buffer.from(body.audio_base64, 'base64')),
        format: 'mp3',
      }
      if (a?.characters?.length)
        speech.words = wordsFromCharacters(
          a.characters,
          a.character_start_times_seconds ?? [],
          a.character_end_times_seconds ?? [],
        )
      return speech
    },
  }
}

/**
 * Which provider speaks a voice id: Kokoro names (af_heart) go to Kokoro; anything else needs ElevenLabs. With no
 * voice chosen, ElevenLabs when its key is set, else Kokoro's default.
 */
export function pickProvider(
  voice: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): { provider: VoiceProvider; voice: string } {
  const key = env.ELEVENLABS_API_KEY
  if (voice && KOKORO_VOICE.test(voice)) return { provider: kokoro(cwd), voice }
  if (voice) {
    if (!key)
      throw new StepError(
        `Voice "${voice}" isn't a Kokoro voice and ELEVENLABS_API_KEY isn't set. Use a Kokoro voice (af_heart, am_michael, bf_emma, …).`,
      )
    return { provider: elevenlabs(key), voice }
  }
  if (key) return { provider: elevenlabs(key), voice: env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE }
  return { provider: kokoro(cwd), voice: DEFAULT_KOKORO_VOICE }
}

/** Any audio the providers return, as mono 16-bit PCM at SAMPLE_RATE (ffmpeg is installed by netlify-agent-kit). */
export function toPcm(speech: Speech): Uint8Array {
  if (speech.format === 'pcm') return speech.audio
  const dir = mkdtempSync(join(tmpdir(), 'va-pcm-'))
  try {
    const input = join(dir, `in.${speech.format.replace(/[^a-z0-9]/g, '') || 'bin'}`)
    const out = join(dir, 'out.pcm')
    writeFileSync(input, speech.audio)
    run(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', input, '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), out],
      {
        timeoutMs: 2 * 60_000,
      },
    )
    return new Uint8Array(readFileSync(out))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
