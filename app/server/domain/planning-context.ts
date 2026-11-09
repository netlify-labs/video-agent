// The context the planner sees (plan v2 §4, §14 rule 16): an allowlisted, size-bounded digest of context/ and,
// when BRAND_ZIP_URL is set, the brand kit's BRAND.md and brand.json. Built at deploy time into the API function
// (never published to the site) and identified by hash, so each plan records exactly which context it used.
import { createHash } from 'node:crypto'

/** Files the planner may read, in order. Anything else in context/ or the zip is ignored. */
export const PLANNING_CONTEXT_FILES = ['BRAND.md', 'PRODUCT.md', 'brand.json'] as const
export const PER_FILE_LIMIT = 8_000
export const TOTAL_LIMIT = 20_000

export interface ContextSource {
  /** Where it came from: 'brand kit' (BRAND_ZIP_URL) or 'context/'. */
  origin: 'brand kit' | 'context/'
  name: string
  text: string
}

export interface PlanningContext {
  text: string
  hash: string
  sources: string[]
}

/** Joins sources into labelled sections; long files are cut with an explicit note, never silently. */
export function buildContextDigest(sources: ContextSource[]): PlanningContext {
  const sections: string[] = []
  const used: string[] = []
  let total = 0
  for (const s of sources) {
    if (!(PLANNING_CONTEXT_FILES as readonly string[]).includes(s.name)) continue
    let body = s.text.trim()
    if (!body) continue
    if (body.length > PER_FILE_LIMIT)
      body = `${body.slice(0, PER_FILE_LIMIT)}\n[trimmed: the first ${PER_FILE_LIMIT} characters]`
    const section = `## ${s.origin}${s.name}\n${body}`
    if (total + section.length > TOTAL_LIMIT) break
    sections.push(section)
    used.push(`${s.origin}${s.name}`)
    total += section.length
  }
  const text = sections.join('\n\n')
  return { text, hash: createHash('sha256').update(text).digest('hex').slice(0, 16), sources: used }
}
