// A video's spoken language (plan 2026-11-02 §6.6 "Language", bead va-2qq.7.6): a BCP-47 primary language subtag,
// stored per video (jobs.language, default 'en'), frozen into bundle.narration and passed to the STT stage. The local
// provider (Parakeet TDT 0.6B v3 through HyperFrames) covers the 25 European languages below and detects which one
// it hears itself (HyperFrames uses --language only to check coverage); ElevenLabs Scribe is sent it as
// language_code. A language Parakeet doesn't cover needs ElevenLabs, or the run goes without narration captions.

export const DEFAULT_LANGUAGE = 'en'

/** HyperFrames 0.8.222's PARAKEET_LANGUAGES (parakeet-tdt-0.6b-v3). */
export const PARAKEET_LANGUAGES = [
  'en',
  'es',
  'fr',
  'de',
  'bg',
  'hr',
  'cs',
  'da',
  'nl',
  'et',
  'fi',
  'el',
  'hu',
  'it',
  'lv',
  'lt',
  'mt',
  'pl',
  'pt',
  'ro',
  'sk',
  'sl',
  'sv',
  'ru',
  'uk',
] as const

/** Every language a video can be set to: Parakeet's, plus widely spoken ones ElevenLabs Scribe transcribes. */
export const LANGUAGES = [...PARAKEET_LANGUAGES, 'ar', 'hi', 'id', 'ja', 'ko', 'tr', 'vi', 'zh'] as const

export type Language = (typeof LANGUAGES)[number]

export const isLanguage = (x: unknown): x is Language =>
  typeof x === 'string' && (LANGUAGES as readonly string[]).includes(x)

/** Whether the local provider transcribes this language. */
export const parakeetCovers = (language: string) =>
  (PARAKEET_LANGUAGES as readonly string[]).includes(language)
