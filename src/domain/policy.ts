// Who can do what. Every route calls `assertCan`; policy.test.ts enumerates every route.
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
  | 'keys:manage'
  | 'users:manage'
  | 'stats:read'
  | 'attempts:resolve'

export interface Resource {
  ownerId?: string
  authorId?: string
}

const ANY_MEMBER: Action[] = ['video:read', 'video:create', 'version:create', 'keys:manage']
const AUTHOR_OWNER: Action[] = ['version:retry', 'version:cancel']
const OWNER: Action[] = ['video:rename', 'video:publish', 'video:delete']
const ADMIN_ONLY: Action[] = ['users:manage', 'stats:read', 'attempts:resolve']

export function can(p: Principal, action: Action, r: Resource = {}): boolean {
  if (p.role === 'admin') return true
  if (ANY_MEMBER.includes(action)) return true
  if (AUTHOR_OWNER.includes(action)) return r.authorId === p.userId || r.ownerId === p.userId
  if (OWNER.includes(action)) return r.ownerId === p.userId
  if (ADMIN_ONLY.includes(action)) return false
  return false
}

export function assertCan(p: Principal, action: Action, r: Resource = {}) {
  if (!can(p, action, r)) throw new ApiError('forbidden', `You can't ${action.replace(':', ' ')} here.`)
}
