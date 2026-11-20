// The ElevenLabs voices a video can be spoken in, for the voice picker (GET /api/v1/voices). Without ElevenLabs the
// list is empty and voice-overs use the built-in Kokoro voices. With a key functions can read, it is the account's
// own voices (the key needs ElevenLabs' "Voices: read" permission); otherwise ElevenLabs' default voices, which
// every plan may use.
import type { Deps } from '../deps.js'
import { DEFAULT_ELEVENLABS_VOICE } from '../lib/voice.js'

export interface VoiceOption {
  id: string
  name: string
  /** A few words on how it sounds (accent, style), or null. */
  description: string | null
  /** A short sample to play, or null. */
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
  const preview = text(v.preview_url, 500)
  return {
    id,
    name,
    description: words.length ? words.join(', ') : null,
    previewUrl: preview?.startsWith('https://') ? preview : null,
  }
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

export async function listVoices(deps: Pick<Deps, 'config' | 'fetch' | 'clock'>): Promise<Voices> {
  const { elevenlabsKeySet, elevenlabsApiKey, elevenlabsVoiceId } = deps.config
  if (!elevenlabsKeySet) return { provider: 'kokoro', default: null, source: 'none', items: [] }
  const fallback = elevenlabsVoiceId ?? DEFAULT_ELEVENLABS_VOICE
  const account = elevenlabsApiKey ? await accountVoices(deps, elevenlabsApiKey) : null
  return {
    provider: 'elevenlabs',
    default: fallback,
    source: account ? 'account' : 'defaults',
    items: account ?? ELEVENLABS_DEFAULT_VOICES,
  }
}
