// ElevenLabs Scribe (plan 2026-11-02 §6.6): opt-in only, when an admin sets transcriptionProvider = 'elevenlabs'
// and the deployer set ELEVENLABS_API_KEY. It sends the narration audio out, which the setup docs disclose.
//   POST https://api.elevenlabs.io/v1/speech-to-text (multipart): file, model_id=scribe_v1,
//        timestamps_granularity=word, language_code, diarize=false, tag_audio_events=false
//   200: { language_code, text, words: [{ text, start, end, type: 'word' | 'spacing' | 'audio_event' }] } (seconds)
// Scribe's word times are used as they are (no offset correction: S11 only measured Parakeet).
import { readFileSync } from 'node:fs'
import { remaining, SttTimeout, type SttProvider, type SttWord } from './types.js'

export const SCRIBE_MODEL = 'scribe_v1'
export const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text'

/** Scribe's response: only `type: 'word'` entries (spacing and audio events are dropped). */
export function parseScribe(body: unknown): SttWord[] {
  const words = (body as { words?: unknown } | null)?.words
  if (!Array.isArray(words)) throw new Error('ElevenLabs returned no words.')
  const out: SttWord[] = []
  for (const item of words as unknown[]) {
    const x = (item ?? {}) as Record<string, unknown>
    if (x.type !== undefined && x.type !== 'word') continue
    const text = typeof x.text === 'string' ? x.text.trim() : ''
    const start = Number(x.start)
    const end = Number(x.end)
    if (text && Number.isFinite(start) && Number.isFinite(end))
      out.push({ text, start: Math.max(0, start), end: Math.max(start, end) })
  }
  return out
}

export function scribe(apiKey: string, fetchImpl: typeof fetch = fetch): SttProvider {
  return {
    name: 'elevenlabs',
    model: SCRIBE_MODEL,
    async transcribe(wav, opts) {
      const started = Date.now()
      const form = new FormData()
      form.set('model_id', SCRIBE_MODEL)
      form.set('timestamps_granularity', 'word')
      form.set('language_code', opts.language)
      form.set('diarize', 'false')
      form.set('tag_audio_events', 'false')
      form.set('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'narration.wav')
      let res: Response
      try {
        res = await fetchImpl(SCRIBE_URL, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey },
          body: form,
          signal: AbortSignal.timeout(remaining(opts.deadlineAt)),
        })
      } catch (e) {
        if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
          throw new SttTimeout('ElevenLabs transcription ran past the deadline.')
        throw e
      }
      const body = (await res.json().catch(() => ({}))) as { detail?: { message?: string } | string }
      if (!res.ok) {
        const detail = typeof body.detail === 'string' ? body.detail : body.detail?.message
        throw new Error(`ElevenLabs returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`)
      }
      return {
        words: parseScribe(body),
        provider: 'elevenlabs',
        model: SCRIBE_MODEL,
        durationMs: Date.now() - started,
      }
    },
  }
}
