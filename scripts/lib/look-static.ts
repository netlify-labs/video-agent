// The static half of look:check (plan 2026-11-04-looks §9): everything that needs no browser, so it runs in the
// Netlify build (scripts/lib/looks.ts) and in CI. Problems are collected, never thrown, so a contributor sees every
// line in one run. The browser half (hyperframes check on the example) is scripts/look-check.ts without --static.
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { validate, type Summary } from '../../app/server/lib/contract.js'
import { sha256Hex as sha256 } from '../../app/server/lib/crypto.js'
import {
  CreditsSchema,
  isPreviewFile,
  LOOK_EXTENSIONS,
  LOOK_LIMITS,
  LookFileError,
  lookFiles,
  lookJsonProblems,
  REQUIRED_LOOK_SECTIONS,
  RegistryLockSchema,
  type LookJson,
} from '../../app/server/lib/looks.js'
import { classify } from '../../app/server/lib/media/classify.js'
import { sniffAudio } from '../../app/server/lib/media/audio.js'
import { sniffPreview } from '../../app/server/lib/media/previews.js'
import { sanitizeSvg, SvgError } from '../../app/server/lib/media/svg.js'

type Element = DefaultTreeAdapterMap['element']
type Node = DefaultTreeAdapterMap['node']

export interface StaticCheckOptions {
  /** The pinned HyperFrames version (package.json netlifyAgent.hyperframes.version); the lock's tag must be v<this>. */
  hyperframesVersion: string
  /** app/looks/_template: checked like a look, but preview.mp4 and poster.webp are optional. */
  template?: boolean
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`
const extOf = (p: string) => {
  const i = p.lastIndexOf('.')
  return i > p.lastIndexOf('/') ? p.slice(i).toLowerCase() : ''
}

/**
 * Whether bytes aren't a WOFF2 font: the wOF2 signature, a 48-byte header whose length field is the file's size, and
 * at least one table. Chrome parses a look's fonts at render time, so only real ones get that far.
 */
export function woff2Problem(b: Uint8Array): boolean {
  if (b.byteLength < 48) return true
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return v.getUint32(0) !== 0x774f4632 || v.getUint32(8) !== b.byteLength || v.getUint16(12) === 0
}

/** Bytes that aren't what their extension says, as a problem, or null. */
export function sniffProblem(path: string, b: Uint8Array): string | null {
  const ext = extOf(path)
  const wrong = `${path} isn't a real ${ext.slice(1).toUpperCase()} file`
  try {
    if (ext === '.png' || ext === '.jpg' || ext === '.webp') {
      const c = classify(b, { head: true })
      return c.kind === 'image' && `.${c.ext}` === ext ? null : wrong
    }
    if (ext === '.wav' || ext === '.mp3' || ext === '.ogg') {
      const a = sniffAudio(b)
      return a && `.${a.format}` === ext ? null : wrong
    }
  } catch {
    // Unreadable or unrecognised bytes (sizes can't trip the media limits: look files are 1 MB at most).
    return wrong
  }
  if (ext === '.woff2') return woff2Problem(b) ? wrong : null
  if (ext === '.svg') return svgProblem(path, b)
  // Text files: valid UTF-8 with no NUL bytes; JSON parses.
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return `${path} isn't UTF-8 text`
  }
  if (text.includes('\0')) return `${path} isn't UTF-8 text`
  if (ext === '.json') {
    try {
      JSON.parse(text)
    } catch {
      return `${path} isn't valid JSON`
    }
  }
  return null
}

function* elements(n: Node | DefaultTreeAdapterMap['document']): Generator<Element> {
  if ('tagName' in n) yield n
  if ('childNodes' in n) for (const c of n.childNodes) yield* elements(c)
}

/** Counts elements and attributes; sanitizing an SVG must keep all of them (it drops scripts, handlers, outside links). */
function svgShape(text: string): { elements: number; attrs: number } {
  const start = text.search(/<svg[\s>]/i)
  // parse() wraps the fragment in html/head/body; those don't count.
  const els = [...elements(parse(start >= 0 ? text.slice(start) : text))].filter(
    (e) => !['html', 'head', 'body'].includes(e.tagName),
  )
  return {
    elements: els.length,
    attrs: els.reduce((n, e) => n + e.attrs.filter((a) => a.name !== 'xmlns').length, 0),
  }
}

function svgProblem(path: string, b: Uint8Array): string | null {
  let clean: Uint8Array
  try {
    clean = sanitizeSvg(b)
  } catch (e) {
    return `${path}: ${e instanceof SvgError ? e.message : "isn't a readable SVG"}`
  }
  const before = svgShape(new TextDecoder().decode(b))
  const after = svgShape(new TextDecoder().decode(clean))
  return after.elements < before.elements || after.attrs < before.attrs
    ? `${path} has scripts, event handlers or outside links (the SVG sanitizer would remove them)`
    : null
}

const LITERAL_COLOR =
  /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9.,%\s/+-]+\)|[a-z]+)$/i

const NON_TEXT = new Set(['script', 'style', 'template', 'audio', 'video', 'img', 'source', 'track'])

const attrOf = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value ?? null

/** Visible text outside any data-va-text element (the editor can only edit text it can find). */
function untaggedText(html: string): string[] {
  const out: string[] = []
  const root = [...elements(parse(html))].find(
    (e) => attrOf(e, 'data-composition-id') !== null && attrOf(e, 'data-va-contract') !== null,
  )
  if (!root) return out
  const visit = (e: Element, tagged: boolean) => {
    if (NON_TEXT.has(e.tagName)) return
    const here = tagged || attrOf(e, 'data-va-text') !== null
    for (const c of e.childNodes) {
      if (c.nodeName === '#text') {
        const t = (c as DefaultTreeAdapterMap['textNode']).value.trim()
        if (t && !here) out.push(t.slice(0, 40))
      } else if ('tagName' in c) visit(c, here)
    }
  }
  visit(root, false)
  return out
}

/** The example's own rules on top of the editing contract (§9). */
function exampleProblems(dir: string, look: LookJson | null, files: string[]): string[] {
  const p: string[] = []
  const indexPath = join(dir, 'example', 'index.html')
  if (!existsSync(indexPath)) return ['example/index.html is missing']
  const html = readFileSync(indexPath, 'utf8')
  if (Buffer.byteLength(html) > LOOK_LIMITS.exampleHtmlBytes)
    p.push(`example/index.html is ${kb(Buffer.byteLength(html))}, over ${kb(LOOK_LIMITS.exampleHtmlBytes)}`)
  let summary: Summary | undefined
  const summaryPath = join(dir, 'example', 'summary.json')
  if (!existsSync(summaryPath)) p.push('example/summary.json is missing')
  else
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Summary
    } catch {
      // sniffProblem reports invalid JSON.
    }
  for (const v of validate(html, summary)) p.push(`example breaks the editing contract: ${v}`)

  for (const f of files.filter((f) => f.startsWith('example/') && /\.(html|css|js|json|svg)$/.test(f))) {
    const text = readFileSync(join(dir, f), 'utf8')
    const url = /(?:https?:)?\/\/(?!www\.w3\.org\/)[a-z0-9-]+\.[a-z0-9.-]+/i.exec(text)
    if (url) p.push(`${f} links outside the look (${url[0]}); use files inside example/`)
    if (/(?:src|href)\s*=\s*["']?\s*\.\.\//i.test(text) || /url\(\s*["']?\.\.\//i.test(text))
      p.push(`${f} refers to a file outside example/ (../)`)
    // The look's own assets, where a run puts them: video/assets/look/<path> is the look's assets/<path>.
    for (const m of text.matchAll(/assets\/look\/([\w/-]+\.[a-z0-9]+)/g))
      if (!files.includes(`assets/${m[1]}`))
        p.push(`${f} refers to assets/look/${m[1]}, which isn't in the look's assets/`)
    if (/\bDate\.now\s*\(/.test(text)) p.push(`${f} uses Date.now(); renders must be deterministic`)
    if (/\bMath\.random\s*\(/.test(text)) p.push(`${f} uses Math.random(); renders must be deterministic`)
  }

  if (look) {
    const allowed = new Set([...look.colors.roles, ...look.colors.derived])
    const used = new Set(
      [...html.matchAll(/--va-color-([a-z0-9-]+)/gi)].map((m) => (m[1] ?? '').toLowerCase()),
    )
    for (const r of [...used].sort())
      if (!allowed.has(r)) p.push(`example uses --va-color-${r}, which look.json colors doesn't list`)
    for (const m of html.matchAll(/--va-color-([a-z0-9-]+)\s*:\s*([^;}\n]+)/gi)) {
      const value = (m[2] ?? '').trim()
      if (!LITERAL_COLOR.test(value))
        p.push(
          `example sets --va-color-${m[1]} to ${value.slice(0, 60)}; write colour roles as literal colours`,
        )
    }
  }
  for (const t of untaggedText(html)) p.push(`example text "${t}" has no data-va-text`)
  return p
}

/** look.json's registry list against registry/registry.lock.json, and every vendored file against its sha256. */
function registryProblems(dir: string, look: LookJson | null, files: string[], version: string): string[] {
  const p: string[] = []
  const lockPath = 'registry/registry.lock.json'
  const vendored = files.filter((f) => f.startsWith('registry/') && f !== lockPath)
  if (!files.includes(lockPath)) {
    if (look?.registry.length || vendored.length) p.push(`${lockPath} is missing; run npm run look:vendor`)
    return p
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, lockPath), 'utf8'))
  } catch {
    return p // sniffProblem reports invalid JSON.
  }
  const parsed = RegistryLockSchema.safeParse(raw)
  if (!parsed.success) {
    for (const i of parsed.error.issues) p.push(`${lockPath} ${i.path.join('.') || '(root)'}: ${i.message}`)
    return p
  }
  const lock = parsed.data
  if (lock.tag !== `v${version}`)
    p.push(
      `${lockPath} tag is ${lock.tag}, not v${version} (the pinned HyperFrames); run npm run look:vendor`,
    )
  const names = lock.items.map((i) => i.name)
  if (look && JSON.stringify([...look.registry].sort()) !== JSON.stringify([...names].sort()))
    p.push(`look.json registry [${look.registry.join(', ')}] doesn't match ${lockPath} [${names.join(', ')}]`)
  const locked = new Set<string>()
  for (const item of lock.items)
    for (const f of item.files) {
      const path = `registry/${item.name}/${f.path}`
      locked.add(path)
      if (!files.includes(path)) p.push(`${path} is in ${lockPath} but missing`)
      else if (sha256(readFileSync(join(dir, path))) !== f.sha256)
        p.push(`${path} doesn't match its sha256 in ${lockPath}; run npm run look:vendor`)
    }
  for (const f of vendored) if (!locked.has(f)) p.push(`${f} isn't in ${lockPath}`)
  return p
}

function creditsProblems(dir: string, files: string[]): string[] {
  const assets = files.filter((f) => f.startsWith('assets/') && f !== 'assets/credits.json')
  if (!files.includes('assets/credits.json'))
    return assets.length
      ? ['assets/credits.json is missing; list every file in assets/ with its licence']
      : []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, 'assets', 'credits.json'), 'utf8'))
  } catch {
    return [] // sniffProblem reports invalid JSON.
  }
  const parsed = CreditsSchema.safeParse(raw)
  if (!parsed.success)
    return parsed.error.issues.map((i) => `assets/credits.json ${i.path.join('.') || '(root)'}: ${i.message}`)
  const p: string[] = []
  const listed = new Set(parsed.data.map((c) => `assets/${c.file}`))
  for (const f of assets) if (!listed.has(f)) p.push(`${f} isn't listed in assets/credits.json`)
  for (const f of listed)
    if (!files.includes(f)) p.push(`assets/credits.json lists ${f}, which doesn't exist`)
  return p
}

function lookMdProblems(dir: string): string[] {
  const path = join(dir, 'LOOK.md')
  if (!existsSync(path)) return ['LOOK.md is missing']
  const text = readFileSync(path, 'utf8')
  const p: string[] = []
  if (Buffer.byteLength(text) > LOOK_LIMITS.lookMdBytes)
    p.push(`LOOK.md is ${kb(Buffer.byteLength(text))}, over ${kb(LOOK_LIMITS.lookMdBytes)}`)
  const headings = new Set(
    [...text.matchAll(/^#{1,3}\s+(.+?)\s*#*\s*$/gm)].map((m) =>
      (m[1] ?? '').replace(/^\d+[.)]\s*/, '').trim(),
    ),
  )
  for (const s of REQUIRED_LOOK_SECTIONS) if (!headings.has(s)) p.push(`LOOK.md has no "${s}" section`)
  return p
}

/** Every static problem with the look folder `dir` (its basename is the id), as `<problem>` lines without the
 * `look:<id>:` prefix. Empty when it passes. */
/** Every font look.json lists exists, and every .woff2 is one look.json lists (a font is never a stray file). */
function fontProblems(look: LookJson | null, files: string[]): string[] {
  const listed = (look?.fonts ?? []).map((f) => f.file)
  return [
    ...listed.filter((f) => !files.includes(f)).map((f) => `look.json fonts lists ${f}, which doesn't exist`),
    ...files
      .filter((f) => extOf(f) === '.woff2' && !listed.includes(f))
      .map((f) => `${f}: a font must be listed in look.json fonts (with its role and licence)`),
  ]
}

export function checkLookStatic(dir: string, opts: StaticCheckOptions): string[] {
  const p: string[] = []
  let files: string[]
  try {
    files = lookFiles(dir)
  } catch (e) {
    if (e instanceof LookFileError) return [e.message]
    throw e
  }

  let look: LookJson | null = null
  if (!files.includes('look.json')) p.push('look.json is missing')
  else {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(dir, 'look.json'), 'utf8'))
    } catch {
      raw = undefined
      p.push("look.json isn't valid JSON")
    }
    if (raw !== undefined) {
      // The template's id is a placeholder look:new replaces, so only its own folder name is skipped.
      const id = raw && typeof raw === 'object' && 'id' in raw ? raw.id : undefined
      const folder = opts.template ? (typeof id === 'string' ? id : '') : basename(dir)
      const problems = lookJsonProblems(raw, folder)
      p.push(...problems)
      if (!problems.length) look = raw as LookJson
    }
  }

  // File rules and sizes.
  let runBytes = 0
  let assetsBytes = 0
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(join(dir, f)))
    if (isPreviewFile(f)) continue
    const ext = extOf(f)
    if (!(LOOK_EXTENSIONS as readonly string[]).includes(ext)) {
      p.push(`${f}: ${ext || 'files without an extension'} isn't allowed in a look`)
      continue
    }
    runBytes += bytes.byteLength
    if (f.startsWith('assets/')) assetsBytes += bytes.byteLength
    if (bytes.byteLength > LOOK_LIMITS.fileBytes)
      p.push(`${f} is ${kb(bytes.byteLength)}, over ${kb(LOOK_LIMITS.fileBytes)} for one file`)
    const sniff = sniffProblem(f, bytes)
    if (sniff) p.push(sniff)
  }
  if (runBytes > LOOK_LIMITS.runBytes)
    p.push(`the look's run files are ${kb(runBytes)}, over ${kb(LOOK_LIMITS.runBytes)}`)
  if (assetsBytes > LOOK_LIMITS.assetsBytes)
    p.push(`assets/ is ${kb(assetsBytes)}, over ${kb(LOOK_LIMITS.assetsBytes)}`)

  // Previews.
  for (const [name, kind, limit] of [
    ['preview.mp4', 'clip.mp4', LOOK_LIMITS.previewBytes],
    ['poster.webp', 'poster-480.webp', LOOK_LIMITS.posterBytes],
  ] as const) {
    if (!files.includes(name)) {
      if (!opts.template) p.push(`${name} is missing (see app/looks/README.md for the preview commands)`)
      continue
    }
    const b = new Uint8Array(readFileSync(join(dir, name)))
    if (!sniffPreview(kind, b)) p.push(`${name} isn't a real ${name.endsWith('.mp4') ? 'MP4' : 'WebP'} file`)
    if (b.byteLength > limit) p.push(`${name} is ${kb(b.byteLength)}, over ${kb(limit)}`)
  }
  for (const f of files)
    if (isPreviewFile(f) && f !== 'preview.mp4' && f !== 'poster.webp')
      p.push(`${f}: only preview.mp4 and poster.webp are allowed at the top of a look`)

  p.push(...lookMdProblems(dir))
  p.push(...fontProblems(look, files))
  p.push(...registryProblems(dir, look, files, opts.hyperframesVersion))
  p.push(...creditsProblems(dir, files))
  p.push(...exampleProblems(dir, look, files))
  return p
}
