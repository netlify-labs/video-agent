// The section a release's notes get (github-action plan §3.9, bead va-mg4i.2.13): between two HTML comments, so a re-run
// replaces it and the rest of the body stays byte for byte.
import { creditLines, facts, publication, type CommentState } from './comment.js'
import { renderMarker, type Marker } from './state.js'

export const SECTION_START = '<!-- video-agent:start -->'
export const SECTION_END = '<!-- video-agent:end -->'

const SECTION = /\n*<!-- video-agent:start -->[\s\S]*?<!-- video-agent:end -->\n*/

export function readSection(body: string): string | null {
  const i = body.indexOf(SECTION_START)
  const j = body.indexOf(SECTION_END)
  return i >= 0 && j > i ? body.slice(i, j + SECTION_END.length) : null
}

export function renderSection(state: CommentState, marker: Marker, webUrl: string): string {
  const lines = [SECTION_START, renderMarker(marker), '', '### Video']
  if (state.kind === 'ready') {
    const v = state.version
    const pub = publication(v)
    if (pub)
      lines.push(
        '',
        `[![What's new](${pub.gif})](${pub.page})`,
        '',
        `**[Watch](${pub.page})** · [MP4](${pub.mp4}) · ${facts(v)}`,
      )
    else lines.push('', `[Open in Video Agent](${webUrl}) (sign in to watch) · ${facts(v)}`)
    const credits = creditLines(v)
    if (credits.length) lines.push('', ...credits)
  } else if (state.kind === 'failed') {
    lines.push(
      '',
      `The video couldn't be made: [Open in Video Agent](${webUrl}) · ${facts(state.version, true)}`,
    )
  } else if (state.kind === 'limit' || state.kind === 'budget') {
    lines.push(
      '',
      `No video was made (${state.kind === 'limit' ? 'max-versions' : state.cap} reached). [Open in Video Agent](${webUrl})`,
    )
  } else {
    lines.push('', `Still making it: [Open in Video Agent](${webUrl})`)
  }
  lines.push(SECTION_END)
  return lines.join('\n')
}

/** The body with the section replaced, or appended after a blank line. */
export function withSection(body: string, section: string): string {
  if (readSection(body)) return body.replace(SECTION, `\n\n${section}\n`).replace(/^\n+/, '')
  const trimmed = body.replace(/\s+$/, '')
  return trimmed ? `${trimmed}\n\n${section}\n` : `${section}\n`
}
