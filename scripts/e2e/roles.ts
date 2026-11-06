// Live check for roles and privacy (plan v2 §13 R gate). Makes no videos; uses an existing ready video.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [REVIEWER_KEY=nva_…] npx tsx scripts/e2e/roles.ts
// With VIDEO_AGENT_KEY (the video's owner or an admin):
//   - a file link issued while the video is public stops working at the edge once it goes private; a fresh one works
//   - the MCP tool list matches the key's role
// With REVIEWER_KEY (a Reviewer's key) as well:
//   - the Reviewer can list videos and approve someone else's version, but create_video isn't offered and the REST
//     create returns the role error; a private video is 404 to them
// Logs JSON lines; exits non-zero on the first failure. Restores the video's privacy before exiting.
import { base, key, log, mcpPost } from './lib.js'

const reviewerKey = process.env.REVIEWER_KEY ?? ''
if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY.')
let restore: (() => Promise<void>) | null = null
const fail = async (msg: string, f: Record<string, unknown> = {}): Promise<never> => {
  log('FAIL', { msg, ...f })
  if (restore) await restore()
  process.exit(1)
}

/** The fields this script reads from API responses. */
interface Json {
  role?: string
  items?: { id: string; private: boolean; versions: { n: number; status: string }[] }[]
  error?: { message?: string }
}

async function api(k: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { authorization: `Bearer ${k}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  const json = (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {}) as Json
  return { status: res.status, json, headers: res.headers }
}

async function mcp(k: string, method: string, params: unknown) {
  const res = await mcpPost(k, method, params)
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result
}

const me = await api(key, 'GET', '/api/v1/me')
log('me', { role: me.json.role })
const list = await api(key, 'GET', '/api/v1/videos?owner=me&status=ready&limit=1')
const video = list.json.items?.[0]
if (!video) await fail('No ready video owned by this key to test with.')
const v = video as NonNullable<typeof video>
const n = v.versions.find((x) => x.status === 'ready')?.n ?? 1
log('video', { id: v.id, n, private: v.private })
const wasPrivate = v.private
const setPrivate = (value: boolean) => api(key, 'PATCH', `/api/v1/videos/${v.id}`, { private: value })
restore = async () => {
  await setPrivate(wasPrivate)
  log('restored', { private: wasPrivate })
}

// 1. Old links stop working at the edge after the video goes private.
if (wasPrivate) await setPrivate(false)
const oldLink =
  (await api(key, 'GET', `/api/v1/videos/${v.id}/versions/${n}/poster`)).headers.get('location') ?? ''
const before = await fetch(`${base}${oldLink}`)
log('public_link', { status: before.status })
if (before.status !== 200) await fail('A fresh public link should work.', { status: before.status })
await setPrivate(true)
const after = await fetch(`${base}${oldLink}`)
log('old_link_after_private', { status: after.status })
if (after.status !== 403)
  await fail('An old link should stop working once the video is private.', { status: after.status })
const newLink =
  (await api(key, 'GET', `/api/v1/videos/${v.id}/versions/${n}/poster`)).headers.get('location') ?? ''
if (!newLink.includes('&e=')) await fail('Private links should carry the access epoch.', { newLink })
const fresh = await fetch(`${base}${newLink}`)
log('private_link', { status: fresh.status })
if (fresh.status !== 200)
  await fail('A fresh private link should work for the owner.', { status: fresh.status })

// 2. The MCP tool list matches the role.
const tools = (await mcp(key, 'tools/list', {})).tools.map((t) => t.name).sort()
log('mcp_tools', { role: me.json.role, tools })
if (['admin', 'creator'].includes(me.json.role ?? '') && !tools.includes('create_video'))
  await fail('Creators and admins should see create_video.')

// 3. Reviewer checks (optional).
if (reviewerKey) {
  const r = await api(reviewerKey, 'GET', '/api/v1/me')
  log('reviewer', { role: r.json.role })
  if (r.json.role !== 'reviewer')
    await fail('REVIEWER_KEY should belong to a Reviewer.', { role: r.json.role })
  const hidden = await api(reviewerKey, 'GET', `/api/v1/videos/${v.id}`)
  log('reviewer_private', { status: hidden.status })
  if (hidden.status !== 404)
    await fail('A private video should be 404 to a Reviewer.', { status: hidden.status })
  await setPrivate(false)
  const verdict = await api(reviewerKey, 'PUT', `/api/v1/videos/${v.id}/versions/${n}/verdict`, {
    verdict: 'approved',
    note: 'e2e',
  })
  log('reviewer_verdict', { status: verdict.status })
  if (verdict.status !== 200) await fail('A Reviewer should be able to approve.', { status: verdict.status })
  await api(reviewerKey, 'PUT', `/api/v1/videos/${v.id}/versions/${n}/verdict`, { verdict: null })
  const create = await api(reviewerKey, 'POST', '/api/v1/videos', { prompt: 'e2e should be refused' })
  log('reviewer_create', { status: create.status, message: create.json.error?.message })
  if (create.status !== 403)
    await fail('A Reviewer must not be able to create videos.', { status: create.status })
  const rtools = (await mcp(reviewerKey, 'tools/list', {})).tools.map((t) => t.name)
  log('reviewer_tools', { tools: rtools })
  if (rtools.includes('create_video') || !rtools.includes('set_verdict'))
    await fail('Reviewer tool list is wrong.')
} else {
  log('reviewer_skipped', { why: 'Set REVIEWER_KEY to a Reviewer key to run the Reviewer checks.' })
}

await restore()
log('PASS')
