// The ElevenLabs voices a video can be spoken in, for the voice picker (GET /api/v1/voices). Without ElevenLabs the
// list is empty and voice-overs use the built-in Kokoro voices. With a key functions can read, it is the account's
// own voices (the key needs ElevenLabs' "Voices: read" permission); otherwise ElevenLabs' default voices, which
// every plan may use.
import { createHash } from 'node:crypto'
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import { DEFAULT_ELEVENLABS_VOICE } from '../lib/voice.js'

export interface VoiceOption {
  id: string
  name: string
  /** A few words on how it sounds (accent, style), or null. */
  description: string | null
  /** A short sample to play (GET /api/v1/voices/{id}/preview), or null when the server can't make one. */
  previewUrl: string | null
}

export interface Voices {
  provider: 'elevenlabs' | 'kokoro'
  /** The voice a video gets when it doesn't choose one; null with Kokoro (af_heart). */
  default: string | null
  /** account: this deployment's ElevenLabs voices; defaults: ElevenLabs' default voices; none: no ElevenLabs. */
  source: 'account' | 'defaults' | 'none'
  items: VoiceOption[]
}

/** ElevenLabs' default voices: free plans may use these through the API, but not library voices. */
export const ELEVENLABS_DEFAULT_VOICES: VoiceOption[] = [
  { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger', description: 'US, laid-back', previewUrl: null },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'US, warm', previewUrl: null },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', description: 'US, deep', previewUrl: null },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'UK, storyteller', previewUrl: null },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'UK, newsreader', previewUrl: null },
]

const TTL_MS = 5 * 60_000
const MAX_VOICES = 200
let cached: { key: string; at: number; items: VoiceOption[] } | null = null

/** For tests: forget the cached account voices. */
export function resetVoicesCache() {
  cached = null
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** One voice from ElevenLabs' GET /v1/voices, or null when it has no usable id or name. */
function voiceOption(raw: unknown): VoiceOption | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const id = text(v.voice_id, 64)
  const full = text(v.name, 120)
  if (!id || !full || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  // ElevenLabs' own voices carry their style in the name ("Roger - Laid-Back, Casual, Resonant").
  const [first, ...rest] = full.split(' - ')
  const name = (first ?? full).trim() || full
  const style = rest.join(' - ').trim().toLowerCase()
  const labels = (v.labels && typeof v.labels === 'object' ? v.labels : {}) as Record<string, unknown>
  const words = [text(labels.accent, 30), style || text(labels.description, 30)].filter(Boolean)
  return { id, name, description: words.length ? words.join(', ') : null, previewUrl: null }
}

/** The account's voices, or null when ElevenLabs refuses or can't be reached (the picker then shows the defaults). */
async function accountVoices(
  deps: Pick<Deps, 'fetch' | 'clock'>,
  key: string,
): Promise<VoiceOption[] | null> {
  const now = deps.clock.now().getTime()
  if (cached?.key === key && now - cached.at < TTL_MS) return cached.items
  try {
    const res = await deps.fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { voices?: unknown }
    if (!Array.isArray(body.voices)) return null
    const items = body.voices
      .map(voiceOption)
      .filter((v): v is VoiceOption => v !== null)
      .slice(0, MAX_VOICES)
      .sort((a, b) => a.name.localeCompare(b.name))
    if (!items.length) return null
    cached = { key, at: now, items }
    return items
  } catch {
    return null
  }
}

/** What each voice says in its sample. */
export const previewLine = (name: string) => `Hi, I'm ${name}. Here's how your next video could sound.`

const previewPath = (id: string) => `/api/v1/voices/${id}/preview`
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024

export async function listVoices(deps: Pick<Deps, 'config' | 'fetch' | 'clock'>): Promise<Voices> {
  const { elevenlabsKeySet, elevenlabsApiKey, elevenlabsVoiceId } = deps.config
  if (!elevenlabsKeySet) return { provider: 'kokoro', default: null, source: 'none', items: [] }
  const fallback = elevenlabsVoiceId ?? DEFAULT_ELEVENLABS_VOICE
  const account = elevenlabsApiKey ? await accountVoices(deps, elevenlabsApiKey) : null
  return {
    provider: 'elevenlabs',
    default: fallback,
    source: account ? 'account' : 'defaults',
    // A sample needs the key: the server speaks it once and keeps it.
    items: (account ?? ELEVENLABS_DEFAULT_VOICES).map((v) => ({
      ...v,
      previewUrl: elevenlabsApiKey ? previewPath(v.id) : null,
    })),
  }
}

/**
 * A listed voice's sample (MP3): spoken by ElevenLabs the first time someone plays it, then kept in Blobs, so each
 * voice costs one short line once. Only listed voices get one, so the route can't be used to speak anything else.
 */
export async function voicePreview(
  deps: Pick<Deps, 'config' | 'fetch' | 'clock' | 'blobs'>,
  id: string,
): Promise<Uint8Array> {
  const key = deps.config.elevenlabsApiKey
  const voice = key ? (await listVoices(deps)).items.find((v) => v.id === id) : undefined
  if (!key || !voice) throw new ApiError('not_found', 'No such voice.')
  const line = previewLine(voice.name)
  const blob = `voice-previews/${voice.id}-${createHash('sha256').update(line).digest('hex').slice(0, 12)}.mp3`
  const kept = await deps.blobs.get('internal', blob)
  if (kept) return kept
  let res: Response
  try {
    res = await deps.fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ text: line, model_id: 'eleven_multilingual_v2' }),
        signal: AbortSignal.timeout(20_000),
      },
    )
  } catch {
    throw new ApiError('upstream_error', "ElevenLabs didn't answer. Try again in a moment.")
  }
  if (!res.ok) throw new ApiError('upstream_error', `ElevenLabs couldn't speak this voice (${res.status}).`)
  const audio = new Uint8Array(await res.arrayBuffer())
  if (!audio.length || audio.length > MAX_PREVIEW_BYTES)
    throw new ApiError('upstream_error', "ElevenLabs didn't return a usable sample.")
  await deps.blobs.set('internal', blob, audio, { contentType: 'audio/mpeg' })
  return audio
}
