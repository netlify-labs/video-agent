// Who may spend credits and whose words reach a run (github-action plan §4.4-4.5, bead va-mg4i.2.4). One check for the
// sender, the PR's author and a commenter: the collaborator-permission endpoint (write, maintain or admin). Spike A3: it
// works with GITHUB_TOKEN's metadata read, answers 200 "none" for outsiders, and a private org member reads as
// CONTRIBUTOR in author_association, so that is only ever a fast accept (OWNER, COLLABORATOR), never a refusal.
import { GitHubError, type GitHub } from './github.js'
import type { Log } from './log.js'

const TRUSTED = new Set(['admin', 'maintain', 'write'])
const FAST_ACCEPT = new Set(['OWNER', 'COLLABORATOR'])

export type Role = 'sender' | 'author' | 'commenter'

export interface Verdict {
  trusted: boolean
  via: 'association' | 'permission'
  permission: string
}

export class Trust {
  readonly #gh: GitHub
  readonly #log: Log
  readonly #cache = new Map<string, Promise<string>>()

  constructor(gh: GitHub, log: Log) {
    this.#gh = gh
    this.#log = log
  }

  /** The login's repo permission, one request per login per run; 404 (not a collaborator) reads as none. */
  permission(login: string): Promise<string> {
    let p = this.#cache.get(login)
    if (!p) {
      p = this.#gh
        .request<{ permission: string }>('GET /repos/{owner}/{repo}/collaborators/{login}/permission', {
          path: { login },
        })
        .then((r) => r.data.permission)
        .catch((e: unknown) => {
          if (e instanceof GitHubError && e.status === 404) return 'none'
          throw e
        })
      this.#cache.set(login, p)
    }
    return p
  }

  async check(role: Role, login: string, association = ''): Promise<Verdict> {
    let v: Verdict
    if (!login) v = { trusted: false, via: 'permission', permission: 'none' }
    else if (FAST_ACCEPT.has(association))
      v = { trusted: true, via: 'association', permission: association.toLowerCase() }
    else {
      const permission = await this.permission(login)
      v = { trusted: TRUSTED.has(permission), via: 'permission', permission }
    }
    this.#log.line({
      trust: v.trusted ? 'ok' : 'refused',
      who: role,
      login: login || '(none)',
      via: v.via,
      permission: v.permission,
    })
    return v
  }
}

/** A PR from a fork: its head repo differs from the base, or the fork was deleted (head.repo null). */
export function isFork(pr: {
  head?: { repo?: { full_name?: string } | null }
  base?: { repo?: { full_name?: string } }
}) {
  const head = pr.head?.repo
  if (head === null || head === undefined) return true
  return head.full_name !== pr.base?.repo?.full_name
}
