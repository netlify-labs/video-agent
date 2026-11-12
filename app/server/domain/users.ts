import { signInMethods } from '../auth/accounts.js'
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import { assertCan, type Principal } from './policy.js'
import type { Role, UserRow } from './types.js'

export const userDto = (u: UserRow, methods: string[] = []) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  admittedVia: u.admittedVia,
  createdAt: u.createdAt,
  lastSeenAt: u.lastSeenAt,
  disabled: u.disabledAt !== null,
  signInMethods: methods,
})

export async function listUsers(deps: Deps, p: Principal) {
  assertCan(p, 'users:manage')
  const methods = await signInMethods(deps)
  const videos = await deps.store.countVideosByOwner()
  return (await deps.store.listUsers()).map((u) => ({
    ...userDto(u, methods.get(u.id)),
    videoCount: videos.get(u.id) ?? 0,
  }))
}

export async function updateUser(
  deps: Deps,
  p: Principal,
  id: string,
  patch: { role?: Role | undefined; disabled?: boolean | undefined },
) {
  assertCan(p, 'users:manage')
  const methods = (await signInMethods(deps)).get(id)
  return deps.store.tx(async (repo) => {
    // Serialize role and disable changes, so two concurrent changes can't remove the last enabled admin.
    await repo.lockQueueControl()
    const u = await repo.getUser(id)
    if (!u) throw new ApiError('not_found', 'User not found.')
    const losesAdmin =
      u.role === 'admin' && ((patch.role !== undefined && patch.role !== 'admin') || patch.disabled === true)
    if (losesAdmin) {
      const admins = (await repo.listUsers()).filter((x) => x.role === 'admin' && !x.disabledAt)
      if (admins.length <= 1) throw new ApiError('conflict', "You can't remove the last admin.")
    }
    const next: Partial<UserRow> = {}
    if (patch.role) next.role = patch.role
    if (patch.disabled !== undefined)
      next.disabledAt = patch.disabled ? (u.disabledAt ?? deps.clock.now().toISOString()) : null
    await repo.updateUser(id, next)
    if (patch.disabled === true) {
      for (const k of await repo.listKeys(id))
        if (!k.revokedAt) await repo.updateKey(k.id, { revokedAt: deps.clock.now().toISOString() })
      await repo.revokeOAuthGrants(id, deps.clock.now().toISOString())
      await repo.revokeUserSessions(id, deps.clock.now().toISOString())
    }
    return userDto({ ...u, ...next }, methods)
  })
}
