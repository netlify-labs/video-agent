// The one sticky comment a PR gets (github-action plan §3.9, bead va-mg4i.2.9): rendered per state with the marker as
// its first line, created once and edited only when the text changes (the GITHUB_TOKEN rate limit is shared).
import type { GitHub } from './github.js'
import { renderMarker, type Marker, type Version } from './state.js'

export type CommentState =
  | { kind: 'started'; revision: number }
  | { kind: 'running'; revision: number; since: string | null }
  | { kind: 'ready'; version: Version }
  | { kind: 'failed'; version: Version; retriesLeft: boolean }
  | { kind: 'still'; minutes: number; version: Version | undefined }
  | { kind: 'limit'; maxVersions: number }
  | { kind: 'budget'; cap: string; used: number; limit: number }

export interface CommentData {
  marker: Marker
  webUrl: string
  /** Server features (redo help only when scoped_revision is listed). */
  features: readonly string[]
  /** An extra line under the state: a duplicate run that was stopped. */
  note?: string
}

export function clock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return ''
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const creditsOf = (v: Version | undefined) => Math.round(v?.usage?.totalCreditsCost ?? 0)

/** The live public links of a version, if it's published. */
export function publication(v: Version) {
  return v.publications.find((p) => p.unpublishedAt === null && p.urls)?.urls ?? null
}

/** CC BY lines: wherever the video is shown, its credits are shown (VersionSchema.credits). */
export function creditLines(v: Version): string[] {
  return v.credits.map((c) => {
    const title = c.sourceUrl ? `[${c.title}](${c.sourceUrl})` : c.title
    const who = c.creator ? ` by ${c.creatorUrl ? `[${c.creator}](${c.creatorUrl})` : c.creator}` : ''
    const license = c.licenseUrl ? `[${c.licenseLabel}](${c.licenseUrl})` : c.licenseLabel
    return `${c.role}: ${title}${who}, ${license}`
  })
}

/** The facts line: m:ss · vN · N credits. */
export function facts(v: Version, failed = false): string {
  const parts = [clock(v.output?.durationSec), `v${v.n}`]
  const credits = creditsOf(v)
  parts.push(failed ? `at least ${credits} credits` : `${credits} credits`)
  return parts.filter(Boolean).join(' · ')
}

function body(state: CommentState, d: CommentData): string[] {
  const app = `[Open in Video Agent](${d.webUrl})`
  switch (state.kind) {
    case 'started':
    case 'running': {
      const what =
        state.revision > 1 ? `Making v${state.revision} of the demo video` : 'Making a demo video of this PR'
      const since =
        state.kind === 'running' && state.since ? ` · running since ${state.since.slice(11, 16)} UTC` : ''
      return [`🎬 **${what}** · about 3 to 8 minutes${since} · ${app}`]
    }
    case 'ready': {
      const v = state.version
      const pub = publication(v)
      const lines = pub
        ? [
            `[![Demo video](${pub.gif})](${pub.page})`,
            '',
            `**[Watch](${pub.page})** · [MP4](${pub.mp4}) · ${facts(v)}`,
          ]
        : [`**Ready:** ${app} (sign in to watch) · ${facts(v)}`]
      const credits = creditLines(v)
      if (credits.length) lines.push('', ...credits)
      lines.push('', 'Revise: reply `/video revise <what to change>`.')
      if (d.features.includes('scoped_revision'))
        lines.push('Redo one scene: reply `/video redo <scene> <what to change>`.')
      if (!pub) lines.push('Reply `/video publish` to show the preview here.')
      return lines
    }
    case 'failed': {
      const v = state.version
      const what =
        v.status === 'timed_out' ? 'timed out' : v.status === 'cancelled' ? 'was cancelled' : 'failed'
      const err = v.error ? `${v.error.category}: ${v.error.message}` : `v${v.n} ${what}`
      return [
        `**The video couldn't be made** (v${v.n} ${what}): ${err} · ${facts(v, true)} · ${app}`,
        '',
        state.retriesLeft ? 'Reply `/video retry` to try again.' : 'No retries left for this version.',
      ]
    }
    case 'still':
      return [
        `⏳ **Still making it** after ${state.minutes} minutes · ${app}`,
        '',
        'Reply `/video status` to check.',
      ]
    case 'limit':
      return [
        `This PR already has ${state.maxVersions} version${state.maxVersions === 1 ? '' : 's'} (the workflow's limit). Revise it in Video Agent instead: ${app}`,
      ]
    case 'budget':
      return [
        `**Budget reached:** ${state.cap} is at ${state.used} of ${state.limit}, so nothing was started. ${app}`,
      ]
  }
}

export function renderComment(state: CommentState, d: CommentData): string {
  const lines = [renderMarker(d.marker), ...body(state, d)]
  if (d.note) lines.push('', d.note)
  return lines.join('\n')
}

/** Creates the comment, or edits it when the text changed. Returns its id. */
export async function upsertComment(
  gh: GitHub,
  pr: number,
  existing: { id: number; body: string } | null,
  text: string,
): Promise<{ id: number; body: string }> {
  if (existing && existing.body === text) return existing
  if (existing) {
    await gh.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      path: { comment_id: existing.id },
      body: { body: text },
    })
    return { id: existing.id, body: text }
  }
  const made = await gh.request<{ id: number }>('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    path: { issue_number: pr },
    body: { body: text },
  })
  return { id: made.data.id, body: text }
}
