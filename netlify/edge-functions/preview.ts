// Sandboxed composition preview: /preview/{jobId}/v{n}/{exp}.{epoch|x}.{sig}/{path} (plan v2 §7; minted by the API).
// Serves only files listed in the version's bundle manifest, under the §7 headers with every CSP source scoped to
// this capability path. index.html gets the vendored runtime first and the bridge last. Authorization is the
// capability alone: the app's session cookie does arrive here (same-site) and is never read. A version's reference
// files (the narration bus) come from the videos store under the same capability, checked against their digest.
import type { Config, Context } from '@netlify/edge-functions'
import { getStore } from '@netlify/blobs'
import { isReference } from '../../app/server/lib/bundle-references.ts'
import { mediaResponse, verifySignedPath, type AccessMirror } from '../../app/server/lib/media/range.ts'
import { denyMicrophone } from '../../app/server/lib/permissions-policy.ts'
import {
  BRIDGE_PATH,
  GSAP_PATH,
  RUNTIME_PATH,
  injectPreviewScripts,
  parsePreviewPath,
  previewBase,
  previewContentType,
  previewHeaders,
  previewScope,
} from '../../app/server/lib/preview.ts'

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } })

interface BundleIndex {
  files: { path: string; size: number; sha256: string; src?: { store: string; key: string } }[]
}
/** Stores a draft's manifest may point into: the base version's bundle, or a library item. */
const SRC_STORES = new Set(['bundles', 'media'])

export default async (req: Request, context: Context) => {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  if (context.deploy?.published !== true && Netlify.env.get('ALLOW_NON_PRODUCTION') !== 'true')
    return plain(404, 'Not found')
  const url = new URL(req.url)
  const t = parsePreviewPath(url.pathname)
  if (!t) return plain(404, 'Not found')

  const internal = getStore({ name: 'internal', consistency: 'strong' })
  const cfg = (await internal.get('edge-config.json', { type: 'json' })) as {
    fileSigningSecret?: string
  } | null
  const access = (await internal.get(`access/${t.jobId}.json`, { type: 'json' })) as AccessMirror | null
  // e/{editId}/r{rev}/… is someone's edit draft: its capability signs that draft, not the version (plan v2 §8).
  const draft = /^e\/([0-9a-f-]{36})\/r(\d{1,6})\/(.+)$/.exec(t.path)
  const scope = draft
    ? `${previewScope(t.jobId, t.versionN)}/e/${draft[1]}`
    : previewScope(t.jobId, t.versionN)
  const ok =
    !!cfg?.fileSigningSecret &&
    (await verifySignedPath(cfg.fileSigningSecret, scope, t.exp, t.sig, Date.now() / 1000, t.epoch)) &&
    !(access?.private && t.epoch !== access.epoch)
  if (!ok) return plain(403, 'This preview link has expired. Reopen the video to get a fresh one.')

  const base = previewBase(url.origin, t)
  // Every bundle file can be a document (index.html, nested scenes, SVGs): none of them gets the microphone.
  const headers = (type: string) => denyMicrophone(previewHeaders(base, type))
  // live/s{seq}/… is the running version's latest checkpoint snapshot (plan v2 §6 A2), under the same capability.
  const live = draft ? null : /^live\/s(\d{1,9})\/(.+)$/.exec(t.path)
  // The path inside the version, draft or snapshot: the vendored runtime is served at the same place in each.
  const path = draft?.[3] ?? live?.[2] ?? t.path
  const vendored: Record<string, string> = {
    [RUNTIME_PATH]: '/_preview/runtime.js',
    [BRIDGE_PATH]: '/_preview/bridge.js',
    [GSAP_PATH]: '/_preview/gsap.js',
  }
  const asset = vendored[path]
  if (asset) {
    const res = await fetch(new URL(asset, url))
    if (!res.ok) return plain(502, 'The preview runtime is missing from this deploy.')
    return new Response(res.body, { headers: headers('text/javascript; charset=utf-8') })
  }

  const bundles = getStore({ name: 'bundles', consistency: 'strong' })
  const prefix = draft
    ? `${t.jobId}/v${t.versionN}/e/${draft[1]}/r${draft[2]}/`
    : live
      ? `${t.jobId}/v${t.versionN}/live/s${live[1]}/`
      : `${t.jobId}/v${t.versionN}/`
  const index = (await bundles.get(`${prefix}manifest.json`, { type: 'json' })) as BundleIndex | null
  // Drafts and live snapshots have no narration bus yet (it's mixed in the run), whatever their manifest says.
  if ((draft || live) && isReference(path)) return plain(404, 'Not in this bundle.')
  const entry = index?.files.find((f) => f.path === path)
  if (!entry) return plain(404, 'Not in this bundle.')
  const type = previewContentType(path)
  if (path === 'index.html') {
    const html = (await bundles.get(`${prefix}f/index.html`, { type: 'text' })) as string | null
    if (html === null) return plain(404, 'Not in this bundle.')
    return new Response(req.method === 'HEAD' ? null : injectPreviewScripts(html), {
      headers: headers(type),
    })
  }
  if (entry.src?.store === 'videos') {
    const key = entry.src.key
    if (!isReference(path) || !key.startsWith(`${t.jobId}/v${t.versionN}/`))
      return plain(404, 'Not in this bundle.')
    let bytes: Uint8Array | null = null
    if (req.method === 'GET') {
      const buf = (await getStore({ name: 'videos', consistency: 'strong' }).get(key, {
        type: 'arrayBuffer',
      })) as ArrayBuffer | null
      if (!buf) return plain(404, 'Not in this bundle.')
      bytes = new Uint8Array(buf)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
      if (hex !== entry.sha256 || bytes.byteLength !== entry.size)
        return plain(502, "This version's narration doesn't match its saved digest.")
    }
    return mediaResponse(
      req,
      {
        size: entry.size,
        etag: `"${entry.sha256.slice(0, 32)}"`,
        open: async () => (bytes ? new Blob([bytes]).stream() : null),
      },
      type,
      headers(type),
    )
  }
  return mediaResponse(
    req,
    {
      size: entry.size,
      etag: `"${entry.sha256.slice(0, 32)}"`,
      open: async () => {
        const src = entry.src && SRC_STORES.has(entry.src.store) ? entry.src : null
        const store = src ? getStore({ name: src.store, consistency: 'strong' }) : bundles
        return (await store.get(src?.key ?? `${prefix}f/${path}`, {
          type: 'stream',
        })) as ReadableStream<Uint8Array> | null
      },
    },
    type,
    headers(type),
  )
}

export const config: Config = { path: '/preview/*' }
