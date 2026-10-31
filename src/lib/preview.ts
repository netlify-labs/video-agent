// The sandboxed composition preview (plan v2 §7, §14 rule 23; design from spike S2, see SPIKES.md). Shared by the API
// (minting) and the /preview edge function (serving), so it stays free of Node-only imports.
//   /preview/{jobId}/v{n}/{cap}/{path}    cap = {exp}.{epoch|x}.{sig}, one capability for the whole bundle
// The composition itself is the sandboxed document: index.html is served with the vendored HyperFrames runtime
// first and the message bridge last. Every CSP source is the capability path, not 'self': a bundle can load only its
// own files, never another bundle, the app or /api. No imports: the edge function (Deno) loads this file directly.

export const PREVIEW_TTL_SEC = 600
const CAP = /^(\d{1,12})\.(\d{1,9}|x)\.([0-9a-f]{64})$/

export interface PreviewTarget {
  jobId: string
  versionN: number
  cap: string
  exp: number
  epoch: number | undefined
  sig: string
  /** Path inside the bundle, decoded. */
  path: string
}

/** What the capability signs: the bundle, never a single file. */
export const previewScope = (jobId: string, n: number) => `/preview/${jobId}/v${n}`

export function parsePreviewPath(pathname: string): PreviewTarget | null {
  const m = /^\/preview\/(vid_[a-z0-9]+)\/v(\d{1,6})\/([^/]+)\/(.+)$/.exec(pathname)
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) return null
  const c = CAP.exec(m[3])
  if (!c?.[1] || !c[2] || !c[3]) return null
  let path: string
  try {
    path = decodeURIComponent(m[4])
  } catch {
    return null
  }
  if (
    path.split('/').some((s) => s === '' || s === '.' || s === '..') ||
    path.includes('\\') ||
    path.includes('\0')
  )
    return null
  return {
    jobId: m[1],
    versionN: Number(m[2]),
    cap: m[3],
    exp: Number(c[1]),
    epoch: c[2] === 'x' ? undefined : Number(c[2]),
    sig: c[3],
    path,
  }
}

/** The base every subresource resolves against, and the only place the CSP lets the page load from. */
export const previewBase = (origin: string, t: Pick<PreviewTarget, 'jobId' | 'versionN' | 'cap'>) =>
  `${origin}${previewScope(t.jobId, t.versionN)}/${t.cap}/`

export function previewCsp(base: string) {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src ${base} 'unsafe-inline'`,
    `style-src ${base} 'unsafe-inline'`,
    `font-src ${base}`,
    `img-src ${base} data:`,
    `media-src ${base}`,
    // The runtime fetches nested scenes from the bundle; nothing else.
    `connect-src ${base}`,
    `frame-src ${base}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

export function previewHeaders(base: string, contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'content-security-policy': previewCsp(base),
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    // The sandboxed page's origin is "null", so nested-scene fetches are cross-origin. Bundle files are
    // capability-gated and never depend on cookies, so any origin may read them.
    'access-control-allow-origin': '*',
  }
}

export const RUNTIME_PATH = '_hf/runtime.js'
export const BRIDGE_PATH = '_hf/bridge.js'

/** The runtime goes first in <head> (or right after the doctype), the bridge last in <body>. */
export function injectPreviewScripts(html: string): string {
  const runtime = `<script src="${RUNTIME_PATH}"></script>`
  const bridge = `<script src="${BRIDGE_PATH}"></script>`
  const at = /<head[^>]*>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html)
  const cut = at ? at.index + at[0].length : 0
  let out = html.slice(0, cut) + runtime + html.slice(cut)
  const body = out.toLowerCase().lastIndexOf('</body>')
  out = body >= 0 ? out.slice(0, body) + bridge + out.slice(body) : out + bridge
  return out
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  vtt: 'text/vtt',
  txt: 'text/plain; charset=utf-8',
}
export const previewContentType = (path: string) =>
  TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
