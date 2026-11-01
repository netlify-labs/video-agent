// Live check for media uploads (spike S5, plan v2 §12, §14 rules 24-26). Uploads a ~100 MB clip.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… CLIP=/path/to/clip.mp4 npx tsx scripts/e2e/media.ts
// On the deployed site: the real request limit around one-request uploads, a session in 4 MB parts (duplicate,
// changed duplicate, corrupted part, missing part, resume), two concurrent completions (one assembly), assembly time,
// Range playback, quota with cancellation, and the SVG sanitizer on a malicious file. Logs JSON lines (the S5 numbers);
// exits non-zero on the first failure. Prints the media id for the next gate.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { base, fail, key, log } from './lib.js'

const clipPath = process.env.CLIP ?? ''
if (!base || !key || !clipPath) throw new Error('Set VIDEO_AGENT_URL, VIDEO_AGENT_KEY and CLIP.')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const auth = { authorization: `Bearer ${key}` }

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body instanceof Uint8Array
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...auth,
      ...(body === undefined
        ? {}
        : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = text ? (JSON.parse(text) as unknown) : {}
  } catch {
    json = { text: text.slice(0, 200) }
  }
  return { status: res.status, json: json as Record<string, unknown> }
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
/** A PNG of the given byte size (valid header, padding after): the size limit is what's being tested. */
function pngOfSize(bytes: number) {
  const head = [
    0x89,
    ...Buffer.from('PNG\r\n\x1a\n', 'latin1'),
    ...be32(13),
    ...Buffer.from('IHDR'),
    ...be32(800),
    ...be32(600),
    8,
    6,
    0,
    0,
    0,
  ]
  const out = new Uint8Array(bytes)
  out.set(head)
  return out
}

// 1. One-request uploads around the limit.
for (const mb of [3.9, 4.4, 6]) {
  const r = await call(
    'POST',
    `/api/v1/media?filename=limit-${mb}.png`,
    pngOfSize(Math.round(mb * 1024 * 1024)),
  )
  log('single_request', {
    mb,
    status: r.status,
    message: (r.json.error as { message?: string } | undefined)?.message ?? null,
  })
  if (mb === 3.9 && r.status !== 201) fail('A 3.9 MB upload should be accepted.')
  if (mb > 4 && r.status === 201) fail('Over 4 MB must use a session.')
  if (r.status === 201) await call('DELETE', `/api/v1/media/${String(r.json.id)}`)
}

// 2. A session in parts.
const clip = new Uint8Array(readFileSync(clipPath))
const s = await call('POST', '/api/v1/media/uploads', {
  filename: 'e2e-clip.mp4',
  size: clip.byteLength,
  sha256: sha(clip),
  caption: 'e2e 100 MB clip',
})
if (s.status !== 201) fail('create session', { status: s.status, json: s.json })
const id = String(s.json.id)
const partSize = Number(s.json.partSize)
const partCount = Number(s.json.partCount)
log('session', { id, bytes: clip.byteLength, partSize, partCount })
const partOf = (i: number) => clip.subarray(i * partSize, Math.min(clip.byteLength, (i + 1) * partSize))
const put = (i: number, body = partOf(i), declared = sha(body)) =>
  call('PUT', `/api/v1/media/uploads/${id}/parts/${i}`, body, { 'x-part-sha256': declared })

const dup0 = await put(0)
const dup1 = await put(0)
const changed = await put(0, new Uint8Array(partSize).fill(9))
const corrupt = await put(1, partOf(1), '0'.repeat(64))
log('part_rules', {
  first: dup0.status,
  duplicate: dup1.json.duplicate,
  changed: changed.status,
  corrupted: corrupt.status,
})
if (dup1.json.duplicate !== true || changed.status !== 409 || corrupt.status !== 400)
  fail('Part rules did not hold.')

const t0 = Date.now()
const todo = Array.from({ length: partCount }, (_, i) => i).filter((i) => i !== 0 && i !== partCount - 2)
for (let i = 0; i < todo.length; i += 4)
  await Promise.all(
    todo.slice(i, i + 4).map(async (n) => {
      const r = await put(n)
      if (r.status !== 200) fail(`part ${n}`, { status: r.status, json: r.json })
    }),
  )
const early = await call('POST', `/api/v1/media/uploads/${id}/complete`, {})
const resumed = await call('GET', `/api/v1/media/uploads/${id}`)
log('resume', {
  missingRefused: early.status,
  uploaded: (resumed.json.uploaded as number[]).length,
  of: partCount,
  uploadMs: Date.now() - t0,
  mbPerSec: Math.round((clip.byteLength / 1048576 / ((Date.now() - t0) / 1000)) * 10) / 10,
})
if (early.status !== 409) fail('Completing with a missing part should be refused.')
await put(partCount - 2)

// 3. Two completions at once: one assembly.
const t1 = Date.now()
const [c1, c2] = await Promise.all([
  call('POST', `/api/v1/media/uploads/${id}/complete`, {}),
  call('POST', `/api/v1/media/uploads/${id}/complete`, {}),
])
log('complete', {
  statuses: [c1.status, c2.status],
  states: [c1.json.status, c2.json.status],
  mediaIds: [c1.json.mediaId, c2.json.mediaId],
})
if (c1.json.mediaId !== c2.json.mediaId) fail('Both completions should point at the same item.')
const mediaId = String(c1.json.mediaId)
let media: Record<string, unknown> = {}
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  media = (await call('GET', `/api/v1/media/${mediaId}`)).json
  if (media.status === 'ready' || media.status === 'rejected') break
}
log('assembled', {
  status: media.status,
  rejectReason: media.rejectReason,
  assemblyMs: Date.now() - t1,
  durationSec: media.durationSec,
  width: media.width,
  height: media.height,
})
if (media.status !== 'ready') fail('The clip should be ready.')

// 4. Range playback through the signed media route.
const file = `${base}${(media.urls as { file: string }).file}`
const head = await fetch(file, { headers: { range: 'bytes=0-1023' } })
const mid = await fetch(file, { headers: { range: `bytes=50000000-${50_000_000 + 65535}` } })
const midBytes = new Uint8Array(await mid.arrayBuffer())
log('range', {
  first: head.status,
  type: head.headers.get('content-type'),
  nosniff: head.headers.get('x-content-type-options'),
  middle: mid.status,
  middleMatches: sha(midBytes) === sha(clip.subarray(50_000_000, 50_000_000 + 65536)),
})
if (
  head.status !== 206 ||
  mid.status !== 206 ||
  sha(midBytes) !== sha(clip.subarray(50_000_000, 50_000_000 + 65536))
)
  fail('Range playback failed.')

// 5. Quota, then cancel to free it.
const reserved: string[] = []
let refused = 0
for (let i = 0; i < 11; i++) {
  const r = await call('POST', '/api/v1/media/uploads', {
    filename: `q${i}.mp4`,
    size: 100 * 1024 * 1024,
    sha256: 'b'.repeat(64),
  })
  if (r.status === 201) reserved.push(String(r.json.id))
  else if (r.status === 429) refused++
}
for (const u of reserved) await call('DELETE', `/api/v1/media/uploads/${u}`)
const after = await call('POST', '/api/v1/media/uploads', {
  filename: 'q.mp4',
  size: 1024,
  sha256: 'c'.repeat(64),
})
await call('DELETE', `/api/v1/media/uploads/${String(after.json.id)}`)
log('quota', { reserved: reserved.length, refused, afterCancel: after.status })
if (refused === 0 || after.status !== 201) fail('Quota should refuse and cancelling should free it.')

// 6. The sanitizer, live.
const evil = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><foreignObject><iframe src="https://evil.example"/></foreignObject><rect width="5" height="5" fill="url(https://evil.example/x)"/></svg>',
)
const svg = await call('POST', '/api/v1/media?filename=e2e-evil.svg', evil)
const svgFile = await fetch(`${base}${(svg.json.urls as { file: string }).file}`)
const svgText = await svgFile.text()
log('svg', {
  status: svg.status,
  served: svgFile.status,
  csp: svgFile.headers.get('content-security-policy'),
  clean: !/script|onload|iframe|evil/.test(svgText),
})
await call('DELETE', `/api/v1/media/${String(svg.json.id)}`)
if (/script|onload|iframe|evil/.test(svgText)) fail('The served SVG was not clean.')

log('PASS', { mediaId })
