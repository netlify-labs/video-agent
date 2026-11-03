// S11 parsers (hyperframes transcribe, whisper.cpp JSON) and scoring against the known transcript.
//
// Expected times: each phrase is a separate TTS clip placed at a known sample offset, so a phrase's speech onset is
// exact (placement + the clip's measured onset). Word times inside a phrase are only estimated: the phrase's speech
// span is split in proportion to each word's letters + 1. So the primary timing metric is the phrase-start error
// (first word of each phrase), with the phrase-end error (last word's end vs the clip's measured speech offset) beside
// it, because some engines (whisper.cpp -ml 1) start a word where the previous one ended, folding pauses into it.
// The all-words error is reported separately as "estimated".

export interface HypWord {
  text: string
  start: number
  end: number
}

export interface ExpectedWord {
  text: string
  start: number
  end: number
  phrase: number
  first: boolean
  last: boolean
}

export const norm = (w: string) =>
  w
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Splits each word into normalized tokens ("well-known" -> "well", "known"), keeping its times. */
export function tokens<T extends { text: string }>(words: T[]): (T & { tok: string })[] {
  const out: (T & { tok: string })[] = []
  for (const w of words)
    norm(w.text)
      .split(' ')
      .filter(Boolean)
      .forEach((tok, k, all) =>
        out.push({
          ...w,
          tok,
          ...(k > 0 && 'first' in w ? { first: false } : {}),
          ...(k < all.length - 1 && 'last' in w ? { last: false } : {}),
        }),
      )
  return out
}

/** hyperframes transcript.json (Parakeet or its whisper engine): [{ id, text, start, end }] in seconds. */
export function parseHyperframesTranscript(json: unknown): HypWord[] {
  if (!Array.isArray(json)) throw new Error('transcript.json is not an array')
  return json
    .filter((w): w is { text: string; start: number; end: number } => {
      const o = w as Record<string, unknown>
      return typeof o.text === 'string' && typeof o.start === 'number' && typeof o.end === 'number'
    })
    .map((w) => ({ text: w.text.trim(), start: w.start, end: w.end }))
    .filter((w) => w.text.length > 0)
}

interface WhisperToken {
  text?: string
  offsets?: { from?: number; to?: number }
  t_dtw?: number
}
interface WhisperSegment {
  text?: string
  offsets?: { from?: number; to?: number }
  tokens?: WhisperToken[]
}

const special = (t: string) => /^\s*\[_?[A-Z_]+[^\]]*\]\s*$/.test(t) || /^\s*[[(].*[\])]\s*$/.test(t)

/**
 * whisper-cli -oj/-ojf output. `mode: 'segments'` reads `transcription[]` (one word per segment with -ml 1 -sow);
 * a segment whose text doesn't start with a space continues the previous word. `mode: 'dtw'` reads tokens' `t_dtw`
 * (centiseconds, needs -ojf --dtw <model>), falling back to the token's offsets.
 */
export function parseWhisperJson(json: unknown, mode: 'segments' | 'dtw' = 'segments'): HypWord[] {
  const segs = (json as { transcription?: WhisperSegment[] }).transcription
  if (!Array.isArray(segs)) throw new Error('whisper JSON has no transcription[]')
  const words: HypWord[] = []
  const push = (text: string, start: number, end: number) => {
    if (!text.trim() || special(text)) return
    const last = words.at(-1)
    if (last && !/^\s/.test(text)) {
      last.text += text
      last.end = Math.max(last.end, end)
    } else words.push({ text: text.trim(), start, end })
  }
  for (const s of segs) {
    if (mode === 'segments') {
      push(s.text ?? '', (s.offsets?.from ?? 0) / 1000, (s.offsets?.to ?? 0) / 1000)
      continue
    }
    for (const t of s.tokens ?? []) {
      const text = t.text ?? ''
      if (special(text)) continue
      const from = (t.offsets?.from ?? 0) / 1000
      const to = (t.offsets?.to ?? 0) / 1000
      const start = typeof t.t_dtw === 'number' && t.t_dtw >= 0 ? t.t_dtw / 100 : from
      push(text, start, Math.max(start, to))
    }
  }
  return words.map((w) => ({ ...w, text: w.text.trim() }))
}

export interface Alignment {
  ref: number
  hyp: number
  substitutions: number
  deletions: number
  insertions: number
  /** Pairs (ref index, hyp index) of exactly matching tokens. */
  matches: [number, number][]
}

/** Levenshtein alignment of token sequences with backtrace. O(n·m) in Int32Arrays (600 s ≈ 1.5k × 1.5k). */
export function align(ref: string[], hyp: string[]): Alignment {
  const n = ref.length
  const m = hyp.length
  const w = m + 1
  const d = new Int32Array((n + 1) * w)
  for (let j = 0; j <= m; j++) d[j] = j
  for (let i = 1; i <= n; i++) {
    d[i * w] = i
    for (let j = 1; j <= m; j++) {
      const sub = d[(i - 1) * w + j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      const del = d[(i - 1) * w + j]! + 1
      const ins = d[i * w + j - 1]! + 1
      d[i * w + j] = Math.min(sub, del, ins)
    }
  }
  const matches: [number, number][] = []
  let [i, j, s, del, ins] = [n, m, 0, 0, 0]
  while (i > 0 || j > 0) {
    const here = d[i * w + j]!
    if (i > 0 && j > 0 && here === d[(i - 1) * w + j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] === hyp[j - 1]) matches.push([i - 1, j - 1])
      else s++
      i--
      j--
    } else if (i > 0 && here === d[(i - 1) * w + j]! + 1) {
      del++
      i--
    } else {
      ins++
      j--
    }
  }
  matches.reverse()
  return { ref: n, hyp: m, substitutions: s, deletions: del, insertions: ins, matches }
}

const ms = (x: number | null) => (x === null ? null : Math.round(x * 1000))

function stats(errs: number[]) {
  const abs = errs.map(Math.abs)
  return {
    n: errs.length,
    medianAbsMs: ms(quantileOf(abs, 0.5)),
    p95AbsMs: ms(quantileOf(abs, 0.95)),
    maxAbsMs: ms(abs.length ? Math.max(...abs) : null),
    medianSignedMs: ms(quantileOf(errs, 0.5)),
  }
}

function debias(errs: number[]): number[] {
  const m = quantileOf(errs, 0.5) ?? 0
  return errs.map((e) => e - m)
}

function quantileOf(xs: number[], q: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo)
}

export function score(expected: ExpectedWord[], hyp: HypWord[]) {
  const ref = tokens(expected)
  const hy = tokens(hyp)
  const a = align(
    ref.map((r) => r.tok),
    hy.map((h) => h.tok),
  )
  const phraseErr: number[] = []
  const phraseEndErr: number[] = []
  const wordErr: number[] = []
  const byMinute = new Map<number, number[]>()
  let phrases = 0
  for (const r of ref) if (r.first) phrases++
  for (const [ri, hi] of a.matches) {
    const r = ref[ri]!
    const h = hy[hi]!
    const e = h.start - r.start
    wordErr.push(e)
    if (r.last) phraseEndErr.push(h.end - r.end)
    if (r.first) {
      phraseErr.push(e)
      const minute = Math.floor(r.start / 60)
      byMinute.set(minute, [...(byMinute.get(minute) ?? []), Math.abs(e)])
    }
  }
  const errors = a.substitutions + a.deletions + a.insertions
  return {
    refWords: a.ref,
    hypWords: a.hyp,
    wer: a.ref ? Math.round((errors / a.ref) * 10000) / 10000 : null,
    substitutions: a.substitutions,
    deletions: a.deletions,
    insertions: a.insertions,
    phraseStart: { ...stats(phraseErr), phrases, coverage: phrases ? Math.round((phraseErr.length / phrases) * 1000) / 1000 : null },
    // Minus the median signed error: what is left if a constant engine offset were corrected.
    phraseStartDebiased: stats(debias(phraseErr)),
    phraseEnd: stats(phraseEndErr),
    wordStartEstimated: stats(wordErr),
    phraseStartMedianAbsMsByMinute: [...byMinute.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([minute, xs]) => ({ minute, medianAbsMs: ms(quantileOf(xs, 0.5)), n: xs.length })),
  }
}

// ---- Self-test fixtures (shapes taken from hyperframes 0.8.222 dist and whisper.cpp's -oj/-ojf writers). ----

export const FIXTURE_EXPECTED: ExpectedWord[] = [
  { text: 'The', start: 0.5, end: 0.7, phrase: 0, first: true, last: false },
  { text: 'river', start: 0.7, end: 1.0, phrase: 0, first: false, last: false },
  { text: 'bends', start: 1.0, end: 1.3, phrase: 0, first: false, last: false },
  { text: 'north.', start: 1.3, end: 1.7, phrase: 0, first: false, last: true },
  { text: 'Lanterns', start: 2.4, end: 2.9, phrase: 1, first: true, last: false },
  { text: 'glow', start: 2.9, end: 3.2, phrase: 1, first: false, last: false },
  { text: 'softly.', start: 3.2, end: 3.7, phrase: 1, first: false, last: true },
]

/** What `hyperframes transcribe --json` leaves in <dir>/transcript.json. */
export const FIXTURE_HYPERFRAMES = [
  { id: 'w0', text: 'The', start: 0.52, end: 0.68 },
  { id: 'w1', text: 'river', start: 0.68, end: 0.98 },
  { id: 'w2', text: 'bends', start: 1.02, end: 1.31 },
  { id: 'w3', text: 'north.', start: 1.31, end: 1.66 },
  { id: 'w4', text: 'Lantern', start: 2.44, end: 2.88 },
  { id: 'w5', text: 'glow', start: 2.9, end: 3.18 },
  { id: 'w6', text: 'softly.', start: 3.2, end: 3.64 },
]

/** whisper-cli -ml 1 -sow -oj: one word per segment, offsets in ms; "[BLANK_AUDIO]" segments are dropped. */
export const FIXTURE_WHISPER = {
  systeminfo: 'AVX = 1 | ...',
  model: { type: 'base' },
  params: { model: 'ggml-base.en.bin', language: 'en', translate: false },
  result: { language: 'en' },
  transcription: [
    { timestamps: { from: '00:00:00,000', to: '00:00:00,480' }, offsets: { from: 0, to: 480 }, text: ' [BLANK_AUDIO]' },
    { timestamps: { from: '00:00:00,480', to: '00:00:00,700' }, offsets: { from: 480, to: 700 }, text: ' The' },
    { timestamps: { from: '00:00:00,700', to: '00:00:01,000' }, offsets: { from: 700, to: 1000 }, text: ' river' },
    { timestamps: { from: '00:00:01,000', to: '00:00:01,150' }, offsets: { from: 1000, to: 1150 }, text: ' be' },
    { timestamps: { from: '00:00:01,150', to: '00:00:01,300' }, offsets: { from: 1150, to: 1300 }, text: 'nds' },
    { timestamps: { from: '00:00:01,300', to: '00:00:01,700' }, offsets: { from: 1300, to: 1700 }, text: ' north.' },
    { timestamps: { from: '00:00:02,380', to: '00:00:02,900' }, offsets: { from: 2380, to: 2900 }, text: ' Lanterns' },
    { timestamps: { from: '00:00:02,900', to: '00:00:03,200' }, offsets: { from: 2900, to: 3200 }, text: ' glow' },
    { timestamps: { from: '00:00:03,200', to: '00:00:03,700' }, offsets: { from: 3200, to: 3700 }, text: ' softly.' },
  ],
}

/** whisper-cli -ojf --dtw base.en: token-level, t_dtw in centiseconds; special tokens start with "[_". */
export const FIXTURE_WHISPER_DTW = {
  transcription: [
    {
      offsets: { from: 0, to: 1700 },
      text: ' The river bends north.',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 }, t_dtw: -1 },
        { text: ' The', offsets: { from: 480, to: 700 }, t_dtw: 49 },
        { text: ' river', offsets: { from: 700, to: 1000 }, t_dtw: 71 },
        { text: ' bends', offsets: { from: 1000, to: 1300 }, t_dtw: 101 },
        { text: ' north', offsets: { from: 1300, to: 1650 }, t_dtw: 131 },
        { text: '.', offsets: { from: 1650, to: 1700 }, t_dtw: 165 },
        { text: '[_TT_85]', offsets: { from: 1700, to: 1700 }, t_dtw: -1 },
      ],
    },
    {
      offsets: { from: 2380, to: 3700 },
      text: ' Lanterns glow softly.',
      tokens: [
        { text: ' Lant', offsets: { from: 2380, to: 2600 }, t_dtw: 241 },
        { text: 'erns', offsets: { from: 2600, to: 2900 }, t_dtw: 262 },
        { text: ' glow', offsets: { from: 2900, to: 3200 }, t_dtw: 291 },
        { text: ' softly.', offsets: { from: 3200, to: 3700 }, t_dtw: 321 },
      ],
    },
  ],
}

/** Runs the parsers and scorer on the fixtures; returns a list of failures (empty = pass). */
export function selfTest(): string[] {
  const fails: string[] = []
  const check = (what: string, cond: boolean) => {
    if (!cond) fails.push(what)
  }
  const hf = score(FIXTURE_EXPECTED, parseHyperframesTranscript(FIXTURE_HYPERFRAMES))
  check('hyperframes: 1 substitution (Lantern)', hf.substitutions === 1 && hf.deletions === 0 && hf.insertions === 0)
  check('hyperframes: WER 1/7', Math.abs((hf.wer ?? 0) - 1 / 7) < 1e-3)
  check('hyperframes: phrase coverage 1/2', hf.phraseStart.coverage === 0.5 && hf.phraseStart.medianAbsMs === 20)
  const wh = parseWhisperJson(FIXTURE_WHISPER)
  check('whisper: blank dropped, subword merged', wh.length === 7 && wh[2]?.text === 'bends' && wh[2].end === 1.3)
  const ws = score(FIXTURE_EXPECTED, wh)
  check('whisper: WER 0', ws.wer === 0)
  check('whisper: phrase errors -20/-20 ms', ws.phraseStart.medianAbsMs === 20 && ws.phraseStart.medianSignedMs === -20)
  check('whisper: phrase ends exact', ws.phraseEnd.n === 2 && ws.phraseEnd.maxAbsMs === 0)
  const dtw = parseWhisperJson(FIXTURE_WHISPER_DTW, 'dtw')
  check('whisper dtw: tokens merged into 7 words', dtw.length === 7 && dtw[3]?.text === 'north.' && dtw[4]?.text === 'Lanterns')
  const ds = score(FIXTURE_EXPECTED, dtw)
  check('whisper dtw: WER 0, phrase starts 10 ms', ds.wer === 0 && ds.phraseStart.medianAbsMs === 10)
  const big = align(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])
  check('align: 1 sub + 1 ins', big.substitutions === 1 && big.insertions === 1 && big.deletions === 0)
  check('norm: punctuation and apostrophes', norm("Isn't it, well-known?") === 'isnt it well known')
  return fails
}
