// Spike A4: can a workflow download images pasted into a private repo's PR description? Tries each image link
// with no auth, with `Authorization: Bearer GITHUB_TOKEN`, and through the signed URLs in GraphQL `bodyHTML`.
// Follows at most 3 redirects by hand and prints every hop's host, so the results say which hosts would need the
// token. Never prints the token or image bytes. No dependencies; Node 20+.
import { appendFileSync, readFileSync } from 'node:fs'

const token = process.env.GH_TOKEN
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
const pr = event.pull_request
if (!pr) {
  console.log('a4: not a pull_request event; nothing to do')
  process.exit(0)
}
const rows = []

const linksIn = (text) => [
  ...new Set([
    ...[...text.matchAll(/!\[[^\]]*\]\((https:[^)\s]+)\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/<img[^>]+src="(https:[^"]+)"/g)].map((m) => m[1]),
  ]),
]

async function download(url, auth) {
  const hops = []
  let current = url
  for (let i = 0; i <= 3; i++) {
    const host = new URL(current).host
    // The token goes only to the first hop: never to a host it redirects to.
    const headers = auth && i === 0 ? { authorization: `Bearer ${token}` } : {}
    const res = await fetch(current, { headers, redirect: 'manual' })
    hops.push(`${host} ${res.status}`)
    const next = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && next) {
      current = new URL(next, current).toString()
      continue
    }
    const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0
    return { ok: res.ok, status: res.status, type: res.headers.get('content-type'), bytes, hops }
  }
  return { ok: false, status: 'too many redirects', hops }
}

const bodyLinks = linksIn(pr.body ?? '')
console.log(`a4: ${bodyLinks.length} image link(s) in the PR body`)
for (const [i, url] of bodyLinks.entries()) {
  const host = new URL(url).host
  for (const auth of [false, true]) {
    const r = await download(url, auth)
    rows.push({ img: `body #${i + 1} (${host})`, method: auth ? 'Bearer GITHUB_TOKEN' : 'no auth', ...r })
  }
}

// GraphQL bodyHTML rewrites attachment links to signed URLs (if the token can read the PR).
const [owner, name] = process.env.GITHUB_REPOSITORY.split('/')
const gql = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    query:
      'query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){bodyHTML}}}',
    variables: { o: owner, n: name, p: pr.number },
  }),
})
const gqlJson = await gql.json().catch(() => null)
const html = gqlJson?.data?.repository?.pullRequest?.bodyHTML ?? ''
console.log(`a4: graphql status=${gql.status} errors=${JSON.stringify(gqlJson?.errors ?? null)}`)
for (const [i, url] of linksIn(html.replace(/&amp;/g, '&')).entries()) {
  const r = await download(url, false)
  rows.push({ img: `bodyHTML #${i + 1} (${new URL(url).host})`, method: 'signed URL, no auth', ...r })
}

const md = [
  `### A4 probe: PR #${pr.number}, repo ${event.repository?.private ? 'private' : 'public'}`,
  '',
  '| Image | Method | Result | Type | Bytes | Hops |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map(
    (r) =>
      `| ${r.img} | ${r.method} | ${r.status} | ${r.type ?? ''} | ${r.bytes ?? ''} | ${r.hops.join(' → ')} |`,
  ),
  '',
  'Re-run this job after 10 minutes and after an hour to see whether bodyHTML signed URLs expire (they are fetched fresh each run).',
  '',
].join('\n')
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
console.log(md)
