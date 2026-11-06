// Text a run reports about itself (the Agent Runner's latest step, its failure message, a checkpoint's note) reaches
// people through the API, the video page, MCP, webhooks, the SDK and the GitHub Action. The agent's last shell
// command can carry secrets (render-job's callback --token, an Authorization header, a KEY=value), so every such text
// is redacted where it's stored and again where it's served (rows stored before this redaction included).

import { PATTERN_SOURCES } from './privacy-patterns.js'

const HIDDEN = '[hidden]'

// A secret's value after its name: --token x, --token=x, Authorization: Bearer x, NAME_KEY=x, ?signature=x.
const RULES: [RegExp, string][] = [
  [
    /(^|\s)(--?(?:[a-z0-9-]*-)?(?:token|key|secret|password|passwd|auth|credential)s?)(?:=|\s+)(?!-)("[^"]*"|'[^']*'|\S+)/gi,
    `$1$2 ${HIDDEN}`,
  ],
  [/(authorization\s*[:=]\s*)(?:(bearer|basic|token)\s+)?("[^"]*"|'[^']*'|[^\s'"]+)/gi, `$1$2 ${HIDDEN}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${HIDDEN}`],
  [
    /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g,
    `$1=${HIDDEN}`,
  ],
  [
    /([?&](?:x-amz-[a-z-]*|signature|sig|token|access_token|key|api_key|apikey|secret|expires|x-goog-[a-z-]*|se|sp|sv|st|skoid)=)[^&\s"'`]+/gi,
    `$1${HIDDEN}`,
  ],
]
// The privacy patterns' provider keys, JWTs and long letter-and-digit runs (bearer tokens, session ids, hashes).
const SECRET_PATTERNS = PATTERN_SOURCES.filter(([kind]) => kind === 'key' || kind === 'token').map(
  ([, source, flags]) => new RegExp(source, flags.includes('g') ? flags : `${flags}g`),
)

/** The text with secret-looking values replaced by [hidden]. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, to] of RULES) out = out.replace(re, to)
  for (const re of SECRET_PATTERNS) out = out.replace(re, HIDDEN)
  return out
}

// The repo's own scripts, as people would say what the run is doing.
const LABELS: [RegExp, string][] = [
  [/scripts\/render-job\.ts/, 'Rendering the video and uploading it'],
  [/scripts\/prepare-run\.ts/, 'Getting the run ready'],
  [/scripts\/checkpoint\.ts/, 'Posting a progress note'],
  [/scripts\/voice\.ts/, 'Recording the voice-over'],
  [/scripts\/recording\.ts/, 'Working on the screen recording'],
  [/scripts\/engine\.ts\s+check|hyperframes\s+check/, 'Checking the composition'],
  [/scripts\/engine\.ts\s+snapshot|hyperframes\s+snapshot/, 'Looking at frames of the video'],
  [/hyperframes\s+render/, 'Rendering'],
]

/**
 * A run's step as people see it: a known script's command becomes what it does ("Rendering the video and uploading
 * it"), any other text keeps its words with secrets redacted, at most 300 characters.
 */
export function stepText(step: string | null | undefined): string | null {
  if (!step) return step ?? null
  const command = /^Run command\s+`([\s\S]*)`?$/.exec(step.trim())?.[1]
  if (command !== undefined) for (const [re, label] of LABELS) if (re.test(command)) return label
  return redactSecrets(step).slice(0, 300)
}
