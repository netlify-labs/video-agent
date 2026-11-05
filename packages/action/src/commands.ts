// `/video` commands in PR comments (github-action plan §3.10, bead va-mg4i.2.11): parsed from the comment, answered with
// reactions on it (👀 when started, 👍 or 😕 when done) and the sticky comment; never a new comment.
import type { GitHub } from './github.js'
import type { PrAction } from './flows.js'

export type Parsed = PrAction | { kind: 'unknown'; word: string }

export const COMMANDS = [
  '/video',
  '/video revise <what to change>',
  '/video redo <scene> <what to change>',
  '/video status',
  '/video publish',
  '/video retry',
  '/video cancel',
]

/** The command in a comment: its first line picks it; `revise` takes the rest of the comment, newlines included. */
export function parseCommand(body: string, commentId: number): Parsed {
  const text = body.replace(/\r\n?/g, '\n')
  const first = /^\/video[ \t]*([^\s]*)[ \t]*/.exec(text)
  const word = (first?.[1] ?? '').toLowerCase()
  const rest = text.slice(first?.[0].length ?? 0).trim()
  switch (word) {
    case '':
      return { kind: 'video' }
    case 'revise':
      return { kind: 'revise', change: rest, commentId }
    case 'redo': {
      // The scene is one word (an id) or a quoted label: /video redo "Pricing card" make it orange
      const quoted = /^"([^"]+)"\s*/.exec(rest)
      const word = /^(\S+)\s*/.exec(rest)
      const m = quoted ?? word
      if (!m?.[1]) return { kind: 'redo', scene: '', change: '', commentId }
      return { kind: 'redo', scene: m[1], change: rest.slice(m[0].length).trim(), commentId }
    }
    case 'status':
      return { kind: 'status' }
    case 'publish':
      return { kind: 'publish' }
    case 'retry':
      return { kind: 'retry' }
    case 'cancel':
      return { kind: 'cancel' }
    default:
      return { kind: 'unknown', word }
  }
}

export type Reaction = 'eyes' | '+1' | 'confused'

/** Reacts on the command's comment. Best effort: a missing permission only logs. */
export async function react(gh: GitHub, commentId: number, content: Reaction): Promise<void> {
  await gh
    .request('POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions', {
      path: { comment_id: commentId },
      body: { content },
    })
    .catch(() => undefined)
}
