// Live check for the microphone Permissions-Policy (record-your-own-voice-over plan §8). Spends nothing.
//   VIDEO_AGENT_URL=https://<site> [VIDEO_AGENT_KEY=nva_…] [PUBLIC_URL=https://<site>/v/<slug>] [VIDEO_ID=vid_…]
//   npx tsx scripts/e2e/headers.ts
// The app's pages must send microphone=(self); the share/embed page (and its not-found page) and the composition
// preview must send microphone=(). With a key, the share page and a preview link come from the newest published
// video; without one (or with nothing published) those checks are skipped and say why. Logs JSON lines; exits
// non-zero if any check fails.
import { base, fail, key, log, sdk } from './lib.js'

if (!base) throw new Error('Set VIDEO_AGENT_URL (and VIDEO_AGENT_KEY for the share-page and preview checks).')

const failures: string[] = []
const skipped: string[] = []

async function check(name: string, url: string, want: string) {
  const t = Date.now()
  const res = await fetch(url)
  await res.body?.cancel()
  const got = res.headers.get('permissions-policy')
  const ok = got === want
  log(ok ? 'ok' : 'mismatch', {
    check: name,
    url: url.replace(/\/preview\/(.+?\/v\d+)\/[^/]+\//, '/preview/$1/<cap>/'),
    status: res.status,
    want,
    got,
    ms: Date.now() - t,
  })
  if (!ok) failures.push(name)
}
const skip = (name: string, why: string) => {
  log('skip', { check: name, why })
  skipped.push(name)
}

// The app: the root and a client-side route, both the SPA's index.html.
await check('app root', `${base}/`, 'microphone=(self)')
await check('app route', `${base}/videos`, 'microphone=(self)')
// The share page's not-found response needs no published video.
await check('public not-found', `${base}/v/zzzzzzzz`, 'microphone=()')

// A published video's share page (also its embed player) and a preview link for one of its versions.
const va = key ? sdk() : null
type Video = Awaited<ReturnType<NonNullable<typeof va>['videos']['get']>>
let video: Video | undefined
if (va && (!process.env.PUBLIC_URL || !process.env.VIDEO_ID)) {
  const list = await va.videos
    .list({ published: 'true', owner: 'all', limit: 1 })
    .catch((e: unknown) => fail('list published videos', { error: String(e) }))
  video = list.items[0]
  log('published video', { id: video?.id ?? null })
}

// Publications are per version (the hand-typed Video here before the SDK had them on the video, so this never found one).
const page =
  process.env.PUBLIC_URL ??
  video?.versions.flatMap((v) => v.publications).find((p) => p.unpublishedAt === null)?.urls?.page
if (page) await check('public page', page, 'microphone=()')
else skip('public page', key ? 'no published video; set PUBLIC_URL' : 'set VIDEO_AGENT_KEY or PUBLIC_URL')

const id = process.env.VIDEO_ID ?? video?.id
if (!va) skip('preview', 'set VIDEO_AGENT_KEY (and VIDEO_ID) to mint a preview link')
else if (!id) skip('preview', 'no published video; set VIDEO_ID')
else {
  const v = video?.id === id ? video : await va.videos.get(id)
  const n = v.versions.find((x) => x.status === 'ready')?.n
  if (!n) skip('preview', `no ready version on ${id}`)
  else {
    const link = await va.versions
      .preview(id, n)
      .catch((e: unknown) => fail('preview link', { id, n, error: String(e) }))
    await check('preview', link.url, 'microphone=()')
  }
}

if (failures.length) fail('permissions-policy', { failures, skipped })
log('PASS', { skipped })
