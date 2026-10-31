// Who can do what: one action × role matrix (plan v2 §3), enforced here so REST, MCP and the UI agree.
// Every route calls `assertCan`; policy.test.ts enumerates every route.
import { ApiError } from '../lib/errors.js'
import type { Role } from './types.js'

export interface Principal {
  kind: 'user' | 'apiKey'
  userId: string
  email: string
  name: string | null
  role: Role
  apiKeyId: string | null
}

export type Action =
  | 'video:read'
  | 'video:create'
  | 'version:create'
  | 'version:retry'
  | 'version:cancel'
  | 'video:rename'
  | 'video:publish'
  | 'video:delete'
  | 'video:private'
  | 'video:incorporate'
  | 'video:transfer'
  | 'comment:create'
  | 'verdict:set'
  | 'plan:create'
  | 'edit:create'
  | 'media:upload'
  | 'keys:manage'
  | 'users:manage'
  | 'settings:manage'
  | 'stats:read'
  | 'attempts:resolve'

export interface Resource {
  ownerId?: string
  authorId?: string
}

export const ROLES: readonly Role[] = ['admin', 'creator', 'reviewer', 'viewer']

// Watching (and holding a key, which inherits the role) is open to everyone signed in.
const EVERYONE: Action[] = ['video:read', 'keys:manage']
// Reviewing: comments and verdicts. Viewers watch only.
const REVIEWERS: Action[] = ['comment:create', 'verdict:set']
// Anything that spends credits or adds team content needs Creator.
const CREATORS: Action[] = ['video:create', 'version:create', 'plan:create', 'edit:create', 'media:upload']
// Owner powers on your own videos (Creator only; admins hold them on every video).
const OWNER: Action[] = [
  'video:rename',
  'video:publish',
  'video:delete',
  'video:private',
  'video:incorporate',
]
const ADMIN_ONLY: Action[] = [
  'users:manage',
  'settings:manage',
  'stats:read',
  'attempts:resolve',
  'video:transfer',
]

const creatorOrUp = (r: Role) => r === 'admin' || r === 'creator'

export function can(p: Principal, action: Action, r: Resource = {}): boolean {
  if (p.role === 'admin') return true
  if (EVERYONE.includes(action)) return true
  if (REVIEWERS.includes(action)) return p.role !== 'viewer'
  if (CREATORS.includes(action)) return creatorOrUp(p.role)
  if (OWNER.includes(action)) return creatorOrUp(p.role) && r.ownerId === p.userId
  // Retry spends credits; cancel stops spend, so a demoted author may still cancel their own run.
  if (action === 'version:retry')
    return creatorOrUp(p.role) && (r.authorId === p.userId || r.ownerId === p.userId)
  if (action === 'version:cancel') return r.authorId === p.userId || r.ownerId === p.userId
  if (ADMIN_ONLY.includes(action)) return false
  return false
}

const ROLE_LIMITS: Partial<Record<Action, string>> = {
  'video:create': 'create videos',
  'version:create': 'make new versions',
  'version:retry': 'retry runs',
  'plan:create': 'plan videos',
  'edit:create': 'edit videos',
  'media:upload': 'upload media',
  'comment:create': 'comment',
  'verdict:set': 'approve versions',
}

export function assertCan(p: Principal, action: Action, r: Resource = {}) {
  if (can(p, action, r)) return
  const what = ROLE_LIMITS[action]
  if (what && p.role !== 'admin' && (p.role === 'viewer' || !creatorOrUp(p.role)))
    throw new ApiError('forbidden', `Your role (${p.role}) can't ${what}. Ask an admin to change it.`)
  throw new ApiError('forbidden', `You can't ${action.replace(':', ' ')} here.`)
}
