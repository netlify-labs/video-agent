// Voice-over (SPIKES.md S9): a narration line per beat becomes one audio file per beat with caption cues and word
// times. Each caption phrase is spoken as its own clip and a beat's clips are joined with measured pauses, so every
// cue starts and ends exactly where its audio does, without transcription. Word times come from the provider when it
// has them and are otherwise spread by letters inside the phrase (marked estimated).
// Pure helpers shared by scripts/voice.ts (in the run), the editing contract and the tests.
import { createHash } from 'node:crypto'

export const VOICE_DIR = 'assets/voice'
export const VOICE_JSON = `${VOICE_DIR}/voice.json`
export const VOICE_SCRIPT = `${VOICE_DIR}/script.json`
/** Every clip is converted to this before joining (Kokoro's own rate). */
export const SAMPLE_RATE = 24_000
/** Seconds of quiet a beat keeps after its voice ends, so the last word isn't cut by the next beat. */
export const VOICE_TAIL = 0.4
/** Where the voice starts in its beat unless the agent chooses otherwise. */
export const DEFAULT_LEAD = 0.3
export const DEFAULT_KOKORO_VOICE = 'af_heart'
/** Kokoro voice ids: a language letter, f or m, then a name (af_heart, bm_george). */
export const KOKORO_VOICE = /^[a-z][fm]_[a-z]+$/
/** A voice id as people may pass it (Kokoro names or provider ids). */
export const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/
export const SPEED_RANGE = [0.7, 1.3] as const
/** How far a placed voice may be from its file's length: one frame. */
export const FPS_TOLERANCE = 1 / 30
const MAX_PHRASE_WORDS = 12

/** For anyone writing narration: text-to-speech guesses how to say a word from its spelling, so a word with two
 * pronunciations ("a live demo" / "we live here") is sometimes spoken the wrong way. */
export const ONE_WAY_WORDS =
  'Use only words that can be said one way: no words spelled the same but said differently by meaning (live, read, lead, close, record, present, content, minute, object, produce, wind, tear). Pick another word or phrase, for example "online" or "up and running" for "live", "finished reading" for "read".'

/**
 * How the voice says terms that Kokoro reads wrong from their spelling, checked against its espeak phonemes in a
 * sentence. Most acronyms (API, CLI, SQL, SDK, PR, JSON, npm) it already spells, so they aren't here. Letters are
 * joined with hyphens: periods ("C.L.I.") add pauses, and a spaced "A" is read as the article. Only the audio
 * changes; captions keep the written words. Add a term when a video says one wrong.
 */
export const SPOKEN_AS: Readonly<Record<string, string>> = {
  'CI/CD': 'CI CD',
  'A/B': 'A-B',
  CLIs: "C-L-I's",
  SaaS: 'sass',
  ISR: 'I-S-R',
  ESM: 'E-S-M',
  ARR: 'A-R-R',
  IoT: 'I-O-T',
  DDoS: 'dee-doss',
  Vite: 'veet',
  Vitest: 'vee-test',
  Deno: 'dee-no',
  Qwik: 'quick',
  Redis: 'red-iss',
  shadcn: 'shad-C-N',
  LLaMA: 'llama',
  '.env': 'dot env',
  '24/7': 'twenty four seven',
  'e.g.': 'for example',
  'i.e.': 'that is',
  'vs.': 'versus',
  vs: 'versus',
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const SPOKEN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}.])(${Object.keys(SPOKEN_AS)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|')})(?![\\p{L}\\p{N}])`,
  'gu',
)

/** A phrase as the voice should say it: terms from SPOKEN_AS, and "50ms" as "50 milliseconds". */
export function spokenText(text: string): string {
  return text
    .replace(SPOKEN_RE, (t) => SPOKEN_AS[t] ?? t)
    .replace(/(?<![\p{L}\p{N}])(\d+(?:\.\d+)?) ?ms(?![\p{L}\p{N}])/gu, '$1 milliseconds')
}

export interface Word {
  text: string
  start: number
  end: number
}

/** One synthesized phrase. Words, when the provider has them, are relative to the clip. */
export interface Speech {
  audio: Uint8Array
  /** File extension of `audio` (wav, mp3, …), for the converter. */
  format: string
  words?: Word[]
}

export interface VoiceProvider {
  readonly name: string
  synthesize(text: string, opts: { voice: string; speed: number }): Promise<Speech>
}

export interface Cue {
  text: string
  start: number
  end: number
}

/** A beat's voice in voice.json; times are seconds from the start of its audio file. */
export interface BeatVoice {
  beat: string
  text: string
  hash: string
  file: string
  duration: number
  cues: Cue[]
  words: Word[]
  estimated: boolean
}

export interface VoiceFile {
  v: 1
  provider: string
  voice: string
  speed: number
  beats: BeatVoice[]
}

export interface VoiceScript {
  voice?: string
  speed?: number
  lines: { beat: string; text: string }[]
}

const round = (n: number) => Math.round(n * 1000) / 1000

/** What decides whether a beat's audio can be reused. */
export function lineHash(provider: string, voice: string, speed: number, text: string): string {
  return createHash('sha256')
    .update(JSON.stringify([provider, voice, speed, text]))
    .digest('hex')
}

/** Phrases to speak one by one: sentences, with long ones split at commas and then every few words. */
export function splitPhrases(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const out: string[] = []
  for (const sentence of clean.split(/(?<=[.!?…])\s+/)) {
    const words = sentence.split(' ')
    if (words.length <= MAX_PHRASE_WORDS) {
      out.push(sentence)
      continue
    }
    let current: string[] = []
    for (const part of sentence.split(/(?<=[,;:—])\s+/)) {
      const pw = part.split(' ')
      if (current.length && current.length + pw.length > MAX_PHRASE_WORDS) {
        out.push(current.join(' '))
        current = []
      }
      current.push(...pw)
      while (current.length > MAX_PHRASE_WORDS) out.push(current.splice(0, 8).join(' '))
    }
    if (current.length) out.push(current.join(' '))
  }
  return out
}

/** The pause after a phrase, from how it ends. */
export function pauseAfter(phrase: string): number {
  if (/[.!?…]["')\]]*$/.test(phrase)) return 0.3
  if (/[,;:—]$/.test(phrase)) return 0.15
  return 0.06
}

/** Word times spread over a phrase by letters (longer words take longer). */
export function estimateWords(text: string, start: number, end: number): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  const weights = tokens.map((t) => Math.max(2, t.replace(/[^\p{L}\p{N}]/gu, '').length + 1))
  const total = weights.reduce((a, b) => a + b, 0)
  let t = start
  return tokens.map((tok, i) => {
    const w = ((weights[i] ?? 0) / total) * (end - start)
    const word = { text: tok, start: round(t), end: round(t + w) }
    t += w
    return word
  })
}

/** Words from a provider's per-character times (ElevenLabs alignment). */
export function wordsFromCharacters(chars: string[], starts: number[], ends: number[]): Word[] {
  const words: Word[] = []
  let cur: Word | null = null
  for (const [i, c] of chars.entries()) {
    if (/\s/.test(c)) {
      if (cur) words.push(cur)
      cur = null
      continue
    }
    const s = starts[i] ?? 0
    const e = ends[i] ?? s
    if (cur) {
      cur.text += c
      cur.end = round(e)
    } else cur = { text: c, start: round(s), end: round(e) }
  }
  if (cur) words.push(cur)
  return words
}

/**
 * Lays a beat's phrase clips back to back with their pauses. `clips` are the phrases with their measured lengths
 * (and provider words); returns the cues, the words and where each clip goes, in samples.
 */
export function layoutBeat(clips: { text: string; seconds: number; words?: Word[] | undefined }[]) {
  const cues: Cue[] = []
  const words: Word[] = []
  const placements: { offsetSamples: number }[] = []
  let estimated = false
  let samples = 0
  clips.forEach((c, i) => {
    const start = samples / SAMPLE_RATE
    const end = start + c.seconds
    cues.push({ text: c.text, start: round(start), end: round(end) })
    placements.push({ offsetSamples: samples })
    if (c.words?.length)
      words.push(
        ...c.words.map((w) => ({ text: w.text, start: round(start + w.start), end: round(start + w.end) })),
      )
    else {
      estimated = true
      words.push(...estimateWords(c.text, start, end))
    }
    samples += Math.round(c.seconds * SAMPLE_RATE)
    if (i < clips.length - 1) samples += Math.round(pauseAfter(c.text) * SAMPLE_RATE)
  })
  return { cues, words, placements, totalSamples: samples, duration: round(samples / SAMPLE_RATE), estimated }
}

/** Joins mono 16-bit PCM clips at their offsets into one WAV file. */
export function joinPcm(pcm: Uint8Array[], placements: { offsetSamples: number }[], totalSamples: number) {
  const data = new Uint8Array(totalSamples * 2)
  pcm.forEach((p, i) => {
    const at = (placements[i]?.offsetSamples ?? 0) * 2
    data.set(p.subarray(0, Math.max(0, Math.min(p.length, data.length - at))), at)
  })
  return wav(data)
}

/** A WAV container around mono 16-bit PCM at SAMPLE_RATE. */
export function wav(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + data.length)
  const v = new DataView(out.buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + data.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, SAMPLE_RATE, true)
  v.setUint32(28, SAMPLE_RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, data.length, true)
  out.set(data, 44)
  return out
}

/** The shortest a beat can be: the voice's lead in the beat, the voice, and a little quiet after it. */
export const minBeatSeconds = (lead: number, voiceSeconds: number) =>
  Math.ceil((lead + voiceSeconds + VOICE_TAIL) * 10) / 10

/** Checks a script.json the agent wrote: known shape, unique lowercase beat ids, non-empty lines. */
export function parseScript(raw: string): VoiceScript {
  const s = JSON.parse(raw) as { lines?: unknown; voice?: unknown; speed?: unknown } | null
  if (!s || !Array.isArray(s.lines) || s.lines.length === 0)
    throw new Error('script.json needs "lines": [{ "beat", "text" }, …].')
  const seen = new Set<string>()
  for (const l of s.lines as ({ beat?: unknown; text?: unknown } | null)[]) {
    if (typeof l?.beat !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(l.beat))
      throw new Error(
        `Line beat "${JSON.stringify(l?.beat)}" must be a beat id (lowercase letters, digits, dashes).`,
      )
    if (seen.has(l.beat)) throw new Error(`Beat "${l.beat}" has two lines; give each beat one line.`)
    seen.add(l.beat)
    if (typeof l.text !== 'string' || !l.text.trim()) throw new Error(`Beat "${l.beat}" has an empty line.`)
    if (l.text.length > 600) throw new Error(`Beat "${l.beat}"'s line is over 600 characters.`)
  }
  if (s.voice !== undefined && (typeof s.voice !== 'string' || !VOICE_ID.test(s.voice)))
    throw new Error('"voice" must be a voice id.')
  if (
    s.speed !== undefined &&
    !(typeof s.speed === 'number' && s.speed >= SPEED_RANGE[0] && s.speed <= SPEED_RANGE[1])
  )
    throw new Error(`"speed" must be between ${SPEED_RANGE[0]} and ${SPEED_RANGE[1]}.`)
  return s as unknown as VoiceScript
}

export interface VoiceCaption {
  start: number
  end: number
  text: string
  beat: string
  voice: true
  beatStart: number
  beatEnd: number
}

/**
 * Caption cues for summary.json from the voice: one per spoken phrase, beat-relative (the voice's lead plus the
 * cue's time in its file) and absolute. Beats without a voice get none.
 */
export function voiceCaptions(
  beats: { id: string; start: number; voice: { start: number } | null }[],
  voice: Pick<VoiceFile, 'beats'>,
): VoiceCaption[] {
  const byBeat = new Map(voice.beats.map((b) => [b.beat, b]))
  return beats.flatMap((b) => {
    const v = byBeat.get(b.id)
    if (!v || !b.voice) return []
    const lead = b.voice.start
    return v.cues.map((c) => ({
      start: round(b.start + lead + c.start),
      end: round(b.start + lead + c.end),
      text: c.text,
      beat: b.id,
      voice: true as const,
      beatStart: round(lead + c.start),
      beatEnd: round(lead + c.end),
    }))
  })
}
