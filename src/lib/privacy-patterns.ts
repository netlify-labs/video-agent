// What privacy mode looks for on screen (screen-recording plan §5.3, "Privacy mode"), and the person's own hide strings.
// One matcher for every place that reads text: the page's DOM while `video-agent record` runs, OCR of the recording on
// the runner, and OCR of the rendered video when it's checked. Pure: no Node or DOM dependencies.
//
// Each pattern is "recommended": common enough in demos to be worth hiding, specific enough that a match is rarely
// wrong. The agent still confirms every OCR candidate by looking at it, so a false positive costs a glance, not a box.

export type PrivacyKind = 'email' | 'key' | 'token' | 'url' | 'card' | 'phone' | 'string'

export interface PrivacyMatch {
  kind: PrivacyKind
  /** Character offsets in the text that was searched. */
  start: number
  end: number
  text: string
}

/** A label for the Hidden list and the agent's reason: "Privacy mode: email". */
export const PRIVACY_LABELS: Record<PrivacyKind, string> = {
  email: 'email',
  key: 'key',
  token: 'token',
  url: 'URL',
  card: 'card number',
  phone: 'phone number',
  string: 'hidden text',
}

/** The most hide strings a demo takes, and how long each may be. */
export const HIDE_STRINGS_MAX = 50
export const HIDE_STRING_CHARS = 200

const PATTERNS: [PrivacyKind, RegExp][] = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  // Provider-shaped secrets: Stripe, GitHub, Slack, AWS access keys, OpenAI/Anthropic-style, Google API keys.
  [
    'key',
    /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|nva_[A-Za-z0-9]{16,})\b/g,
  ],
  // A JWT, then any long unbroken run of letters and digits with both in it (bearer tokens, session ids, hashes).
  ['token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['token', /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g],
  // URLs that carry something: a query string, a UUID or a long id in the path. A bare domain isn't private.
  [
    'url',
    /\bhttps?:\/\/[^\s"'<>]+(?:\?[^\s"'<>]+|\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[^\s"'<>]*|\/[A-Za-z0-9_-]{20,}[^\s"'<>]*)/gi,
  ],
  ['card', /\b(?:\d[ -]?){13,19}\b/g],
  ['phone', /(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g],
]

/** The Luhn check, so a long number is only a card when it could be one. */
function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** Normalizes a hide string for matching: trimmed, inner whitespace collapsed, case ignored. */
export const normalizeHideString = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, HIDE_STRING_CHARS)

/**
 * Every private-looking thing in `text`: the recommended patterns when `patterns` is on (privacy mode), and every
 * occurrence of each hide string (case-insensitive) always. Overlaps keep the longest match.
 */
export function findPrivate(
  text: string,
  opts: { patterns: boolean; strings?: readonly string[] | undefined },
): PrivacyMatch[] {
  const found: PrivacyMatch[] = []
  if (opts.patterns)
    for (const [kind, re] of PATTERNS)
      for (const m of text.matchAll(re)) {
        const s = m[0].replace(/[.,;:)\s-]+$/, '')
        if (kind === 'card' && !luhn(s.replace(/\D/g, ''))) continue
        found.push({ kind, start: m.index, end: m.index + s.length, text: s })
      }
  const lower = text.toLowerCase()
  for (const raw of opts.strings ?? []) {
    const needle = normalizeHideString(raw).toLowerCase()
    if (needle.length < 2) continue
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length))
      found.push({
        kind: 'string',
        start: at,
        end: at + needle.length,
        text: text.slice(at, at + needle.length),
      })
  }
  // Longest first, then drop anything inside a kept match.
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
  const kept: PrivacyMatch[] = []
  for (const m of found) if (!kept.some((k) => m.start < k.end && m.end > k.start)) kept.push(m)
  return kept.sort((a, b) => a.start - b.start)
}
