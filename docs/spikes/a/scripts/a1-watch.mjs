// Spike A1: does a published /v/{slug}.gif render in a PR comment, and how long does GitHub's image proxy (camo)
// keep serving it after an unpublish?
//
//   node docs/spikes/a/scripts/a1-watch.mjs post  <owner/repo> <pr> <site> <slug>   # posts the comment, prints the camo URL
//   node docs/spikes/a/scripts/a1-watch.mjs watch <owner/repo> <comment-id> [minutes=120] [every=10]
//
// `watch` runs after the video is unpublished in the app: every N minutes it fetches the origin GIF and the camo URL
// from the comment's body_html and logs both statuses as JSON lines. Uses `gh` for auth (GH_TOKEN never printed).
// Rendering on the mobile app and in the email notification is checked by hand.
import { execFileSync } from 'node:child_process'

const gh = (...args) => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }))
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }))
const [cmd, repo, a, b, c] = process.argv.slice(2)

function camoOf(commentId) {
  const full = gh(
    '-H',
    'Accept: application/vnd.github.full+json',
    `/repos/${repo}/issues/comments/${commentId}`,
  )
  const img = /<img\b[^>]*?\ssrc="([^"]+)"/.exec(full.body_html ?? '')?.[1]
  const origin = /\]\((https:[^)]+\.gif)\)/.exec(full.body ?? '')?.[1]
  return { camo: img?.replace(/&amp;/g, '&'), origin }
}

async function probe(url) {
  const t = Date.now()
  const res = await fetch(url, { redirect: 'follow' })
  const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0
  return { status: res.status, type: res.headers.get('content-type'), bytes, ms: Date.now() - t }
}

if (cmd === 'post') {
  const [pr, site, slug] = [a, b, c]
  const body = `A1 spike: a published preview GIF.\n\n[![preview](${site}/v/${slug}.gif)](${site}/v/${slug})`
  const comment = gh('-X', 'POST', `/repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`)
  const { camo, origin } = camoOf(comment.id)
  log({ step: 'posted', commentId: comment.id, url: comment.html_url, camo, origin })
  log({ step: 'origin', ...(await probe(origin)) })
  if (camo) log({ step: 'camo', ...(await probe(camo)) })
} else if (cmd === 'watch') {
  const [commentId, minutes = '120', every = '10'] = [a, b, c]
  const { camo, origin } = camoOf(commentId)
  const end = Date.now() + Number(minutes) * 60_000
  for (;;) {
    log({ step: 'check', origin: await probe(origin), camo: camo ? await probe(camo) : null })
    if (Date.now() >= end) break
    await new Promise((r) => setTimeout(r, Number(every) * 60_000))
  }
} else {
  console.error(
    'usage: a1-watch.mjs post <owner/repo> <pr> <site> <slug> | watch <owner/repo> <comment-id> [minutes] [every]',
  )
  process.exit(2)
}
