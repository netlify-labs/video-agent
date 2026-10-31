// Sandboxed composition preview: /preview/{jobId}/v{n}/{exp}.{epoch|x}.{sig}/{path} (plan v2 §7; minted by the API).
// Serves only files listed in the version's bundle manifest, under the §7 headers with every CSP source scoped to
// this capability path. index.html gets the vendored runtime first and the bridge last. Authorization is the
// capability alone: the app's session cookie does arrive here (same-site) and is never read.
import type { Config, Context } from '@netlify/edge-functions'
import { getStore } from '@netlify/blobs'
import { mediaResponse, verifySignedPath, type AccessMirror } from '../../src/lib/media/range.ts'
import {
  BRIDGE_PATH,
  RUNTIME_PATH,
  injectPreviewScripts,
  parsePreviewPath,
  previewBase,
  previewContentType,
  previewHeaders,
  previewScope,
} from '../../src/lib/preview.ts'

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } })

interface BundleIndex {
  files: { path: string; size: number; sha256: string }[]
}

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
  const ok =
    !!cfg?.fileSigningSecret &&
    (await verifySignedPath(
      cfg.fileSigningSecret,
      previewScope(t.jobId, t.versionN),
      t.exp,
      t.sig,
      Date.now() / 1000,
      t.epoch,
    )) &&
    !(access?.private && t.epoch !== access.epoch)
  if (!ok) return plain(403, 'This preview link has expired. Reopen the video to get a fresh one.')

  const base = previewBase(url.origin, t)
  if (t.path === RUNTIME_PATH || t.path === BRIDGE_PATH) {
    const asset = await fetch(
      new URL(t.path === RUNTIME_PATH ? '/_preview/runtime.js' : '/_preview/bridge.js', url),
    )
    if (!asset.ok) return plain(502, 'The preview runtime is missing from this deploy.')
    return new Response(asset.body, { headers: previewHeaders(base, 'text/javascript; charset=utf-8') })
  }

  const bundles = getStore({ name: 'bundles', consistency: 'strong' })
  const prefix = `${t.jobId}/v${t.versionN}/`
  const index = (await bundles.get(`${prefix}manifest.json`, { type: 'json' })) as BundleIndex | null
  const entry = index?.files.find((f) => f.path === t.path)
  if (!entry) return plain(404, 'Not in this bundle.')
  const type = previewContentType(t.path)
  if (t.path === 'index.html') {
    const html = (await bundles.get(`${prefix}f/index.html`, { type: 'text' })) as string | null
    if (html === null) return plain(404, 'Not in this bundle.')
    return new Response(req.method === 'HEAD' ? null : injectPreviewScripts(html), {
      headers: previewHeaders(base, type),
    })
  }
  return mediaResponse(
    req,
    {
      size: entry.size,
      etag: `"${entry.sha256.slice(0, 32)}"`,
      open: async () =>
        (await bundles.get(`${prefix}f/${t.path}`, { type: 'stream' })) as ReadableStream<Uint8Array> | null,
    },
    type,
    previewHeaders(base, type),
  )
}

export const config: Config = { path: '/preview/*' }
