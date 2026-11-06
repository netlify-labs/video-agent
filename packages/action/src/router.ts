// Which kind of work an event asks for (github-action plan §3.3, bead va-mg4i.2.3). Events made with GITHUB_TOKEN never
// start workflows, so `target` lets the action run as a step after a release tool or for a bot-labelled PR.
import type { RunContext } from './context.js'
import type { Inputs } from './inputs.js'

export type Decision =
  | { kind: 'pr-label'; pr: number; reason: string }
  | { kind: 'pr-push'; pr: number; reason: string }
  | { kind: 'command'; pr: number; commentId: number; body: string; commenter: string; reason: string }
  | { kind: 'command-refused'; pr: number; commentId: number; commenter: string; reason: string }
  | { kind: 'release'; tag: string; reason: string }
  | { kind: 'dispatch'; reason: string }
  | { kind: 'none'; reason: string }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const labelsOf = (v: unknown) =>
  Array.isArray(v) ? v.map((l) => (typeof l === 'string' ? l : str(obj(l).name))).filter(Boolean) : []

/** `/video`, `/video revise …`: the command word must be exactly /video. */
export const COMMAND = /^\/video(\s|$)/

export function route(ctx: RunContext, inputs: Inputs): Decision {
  const e = ctx.event
  const action = str(e.action)
  const label = inputs.label
  const t = inputs.target
  if (t?.kind === 'pr') return { kind: 'pr-label', pr: t.number, reason: `target pr/${t.number}` }
  if (t?.kind === 'release') return { kind: 'release', tag: t.tag, reason: `target release/${t.tag}` }

  switch (ctx.eventName) {
    case 'pull_request':
    case 'pull_request_target': {
      const pr = obj(e.pull_request)
      const n = Number(pr.number)
      const has = !label || labelsOf(pr.labels).includes(label)
      if (action === 'labeled') {
        const added = str(obj(e.label).name)
        if (label && added !== label) return { kind: 'none', reason: `label ${added} isn't ${label}` }
        return { kind: 'pr-label', pr: n, reason: `label ${added || '(none needed)'} added` }
      }
      if (action === 'synchronize') {
        if (inputs.onPush !== 'revise') return { kind: 'none', reason: 'new commits, on-push is ignore' }
        if (!has) return { kind: 'none', reason: `new commits, no ${label} label` }
        return { kind: 'pr-push', pr: n, reason: 'new commits, on-push is revise' }
      }
      return { kind: 'none', reason: `nothing to do for pull_request ${action || 'event'}` }
    }
    case 'issue_comment': {
      const issue = obj(e.issue)
      const comment = obj(e.comment)
      const body = str(comment.body)
      if (action !== 'created') return { kind: 'none', reason: `nothing to do for issue_comment ${action}` }
      if (!issue.pull_request) return { kind: 'none', reason: 'a comment on an issue, not a pull request' }
      if (!COMMAND.test(body)) return { kind: 'none', reason: 'not a /video command' }
      const n = Number(issue.number)
      const id = Number(comment.id)
      const commenter = str(obj(comment.user).login)
      if (label && !labelsOf(issue.labels).includes(label))
        return {
          kind: 'command-refused',
          pr: n,
          commentId: id,
          commenter,
          reason: `add the ${label} label first`,
        }
      return { kind: 'command', pr: n, commentId: id, body, commenter, reason: 'a /video command' }
    }
    case 'release': {
      const tag = str(obj(e.release).tag_name)
      if (action !== 'published' || !tag)
        return { kind: 'none', reason: `nothing to do for release ${action}` }
      return { kind: 'release', tag, reason: 'release published' }
    }
    case 'workflow_dispatch':
      return { kind: 'dispatch', reason: 'workflow_dispatch with no target: a one-off video' }
    default:
      return { kind: 'none', reason: `nothing to do for event ${ctx.eventName || 'unknown'}` }
  }
}
