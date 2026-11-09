// Looks (plan 2026-11-04-looks §4.1–§4.3): a look is a folder, app/looks/<id>/, with look.json, LOOK.md, an example
// composition and vendored registry items. This module is shared by the build, scripts/look-*.ts, prepare-run and the
// server: the look.json schema, the size and file-type limits, the list of files a run gets, their hash and the
// deterministic archive the build packs them into. Nothing here logs; file reads are explicit helpers.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ENGINE_IDS } from '../domain/engines.js'
import { ASPECT_RATIOS } from '../domain/types.js'
import { manifestHash } from './bundle-manifest.js'
import { writeTarGz } from './tar.js'

export const LOOK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Plan templates a look can be best for: the planner router's templates (app/server/domain/plans.ts CHECKLISTS keys). */
export const LOOK_TEMPLATES = ['launch', 'tutorial', 'social', 'changelog', 'sales', 'other'] as const

/** Engines a look can list (the render-engines plan's ids); built-ins write ['hyperframes']. */
export const LOOK_ENGINES = ENGINE_IDS

/** The archive prefix: a look archive's entries are look/<path>, and prepare-run unpacks them to context/look/. */
export const LOOK_ARCHIVE_ROOT = 'look'

export const LOOK_LIMITS = {
  /** Everything a run gets (all but preview.* and poster.*). */
  runBytes: 3 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  /** assets/ is all the agent may copy into video/, so it lives in every later archive of that video. */
  assetsBytes: 1024 * 1024,
  lookMdBytes: 12 * 1024,
  exampleHtmlBytes: 24 * 1024,
  previewBytes: 500 * 1024,
  posterBytes: 60 * 1024,
} as const

/** File types a look may contain (.woff2 only as a font look.json lists, under assets/fonts/). */
export const LOOK_EXTENSIONS = [
  '.md',
  '.json',
  '.html',
  '.css',
  '.js',
  '.svg',
  '.png',
  '.webp',
  '.jpg',
  '.wav',
  '.mp3',
  '.ogg',
  '.woff2',
] as const

/** Roles a look's own font may fill when the brand has none for it (§4.4, phase 4.3). */
export const LOOK_FONT_ROLES = ['sans', 'serif', 'mono', 'display', 'hand'] as const
/** Font licences a look may ship: both allow embedding in a rendered video. */
export const LOOK_FONT_LICENSES = ['OFL-1.1', 'Apache-2.0'] as const
export const LOOK_FONT_FILE = /^assets\/fonts\/[a-z0-9][a-z0-9-]{0,60}\.woff2$/

/** The LOOK.md headings look:check requires (§4.4), in order. */
export const REQUIRED_LOOK_SECTIONS = [
  'In one line',
  'Layout',
  'Type',
  'Colour use',
  'Motion',
  'Transitions',
  'Texture and effects',
  'Pacing',
  'Captions and text cues',
  'Sound',
  "Do / Don't",
  'Building blocks',
] as const

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
const role = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'a colour role name, like accent')

/** Screen recordings (screen-recording-demo plan §7): how recording scenes are framed in this look. Colours are the
 * brand's role names. v1 of that plan reads `frame` and `zoomMax`; the rest is accepted so looks keep working. */
export const LookRecordingSchema = z.strictObject({
  frame: z.enum(['wallpaper', 'browser', 'device', 'none']),
  padding: z.number().min(0).max(0.3).optional(),
  radius: z.number().int().min(0).max(120).optional(),
  shadow: z.enum(['none', 'sm', 'md', 'lg']).optional(),
  wallpaper: slug.optional(),
  cursor: z
    .strictObject({
      shape: slug.optional(),
      scale: z.number().min(0.5).max(3).optional(),
      color: role.optional(),
    })
    .optional(),
  ripple: slug.optional(),
  callout: slug.optional(),
  zoomMax: z.number().min(1).max(4).optional(),
})

export const LookJsonSchema = z.strictObject({
  id: z
    .string()
    .regex(LOOK_ID, 'lowercase letters, digits and dashes, up to 40, starting with a letter or digit'),
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(160),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9 -]{0,19}$/, 'lowercase, up to 20 characters')).max(8),
  bestFor: z.array(z.enum(LOOK_TEMPLATES)).max(LOOK_TEMPLATES.length),
  aspects: z.array(z.enum(ASPECT_RATIOS)).min(1).max(ASPECT_RATIOS.length),
  engines: z.array(z.enum(LOOK_ENGINES)).min(1),
  colors: z.strictObject({ roles: z.array(role).min(1).max(16), derived: z.array(role).max(16) }),
  sound: z.strictObject({ musicMood: z.string().trim().min(1).max(120).optional() }).optional(),
  recording: z.union([z.literal(false), LookRecordingSchema]).optional(),
  registry: z.array(slug).max(20),
  /** Fonts it ships for roles the brand may lack; the brand's own font for a role always wins. */
  fonts: z
    .array(
      z.strictObject({
        role: z.enum(LOOK_FONT_ROLES),
        file: z.string().regex(LOOK_FONT_FILE, 'assets/fonts/<name>.woff2'),
        license: z.enum(LOOK_FONT_LICENSES),
        useWhen: z.string().trim().min(1).max(80),
      }),
    )
    .max(4)
    .optional(),
  authors: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
  license: z.string().trim().min(1).max(40),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD'),
})

export type LookJson = z.infer<typeof LookJsonSchema>
export type LookRecording = z.infer<typeof LookRecordingSchema>

/** look.json checked against the schema and its folder name. One message per problem, empty when it's valid. */
export function lookJsonProblems(value: unknown, folder: string): string[] {
  const parsed = LookJsonSchema.safeParse(value)
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((i) => `look.json ${i.path.join('.') || '(root)'}: ${i.message}`)
  const id = (value as { id?: unknown } | null)?.id
  if (typeof id === 'string' && id !== folder)
    problems.push(`look.json id "${id}" doesn't match the folder "${folder}"`)
  if (parsed.success) {
    const dup = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i)
    for (const [k, xs] of [
      ['tags', parsed.data.tags],
      ['bestFor', parsed.data.bestFor],
      ['aspects', parsed.data.aspects],
      ['engines', parsed.data.engines],
      ['registry', parsed.data.registry],
    ] as const)
      for (const d of new Set(dup([...xs]))) problems.push(`look.json ${k}: "${d}" is listed twice`)
  }
  return problems
}

export class LookFileError extends Error {}

/** Files the picker shows but runs never get. */
export const isPreviewFile = (path: string) => !path.includes('/') && /^(preview|poster)\./.test(path)

/** Every file under a look folder (relative, forward slashes, sorted). Refuses symlinks, dotfiles and anything that
 * isn't a plain file or directory, so the archive is exactly what review saw. */
export function lookFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name
      if (name.startsWith('.')) throw new LookFileError(`${path}: dotfiles aren't allowed in a look`)
      const st = lstatSync(join(dir, path))
      if (st.isSymbolicLink()) throw new LookFileError(`${path}: symlinks aren't allowed in a look`)
      if (st.isDirectory()) walk(path)
      else if (st.isFile()) out.push(path)
      else throw new LookFileError(`${path}: only plain files and folders are allowed in a look`)
    }
  }
  walk('')
  return out.sort()
}

/** The files a run gets: everything but preview.* and poster.* at the top. */
export const lookRunFiles = (dir: string) => lookFiles(dir).filter((p) => !isPreviewFile(p))

/** Reads the run files of a look folder into a path → bytes map. */
export function readLookRunFiles(dir: string): Map<string, Uint8Array> {
  return new Map(lookRunFiles(dir).map((p) => [p, new Uint8Array(readFileSync(join(dir, p)))]))
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** The look's hash: manifestHash over its own (path, sha256) list, no media. Paths are relative to the look folder,
 * without the look/ archive prefix, so the build, prepare-run (after unpacking) and local mode hash alike. */
export function lookHash(files: Map<string, Uint8Array>): string {
  return manifestHash(
    [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
    [],
  )
}

export interface LookArchive {
  /** The .tar.gz, entries under look/. */
  bytes: Uint8Array
  sha256: string
  hash: string
  bytesLength: number
}

/** The deterministic archive of a look's run files (the same files always give the same bytes). */
export function buildLookArchive(files: Map<string, Uint8Array>): LookArchive {
  const bytes = writeTarGz(files, { prefix: `${LOOK_ARCHIVE_ROOT}/` })
  return { bytes, sha256: sha256(bytes), hash: lookHash(files), bytesLength: bytes.byteLength }
}

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const relPath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) => !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s && s !== '.' && s !== '..'),
    {
      message: 'a relative path inside the folder',
    },
  )

/** registry/registry.lock.json, written by look:vendor: what each vendored HyperFrames item is and where it came from.
 * File paths are relative to registry/<name>/. */
export const RegistryLockSchema = z.strictObject({
  tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
  items: z.array(
    z.strictObject({
      name: slug,
      type: z.enum(['component', 'block']),
      upstream: z.string().min(1).max(300),
      license: z.string().min(1).max(60),
      author: z.string().min(1).max(200),
      files: z.array(z.strictObject({ path: relPath, sha256: sha256Hex })).min(1),
    }),
  ),
})
export type RegistryLock = z.infer<typeof RegistryLockSchema>

/** Licences a look's assets may carry (CC BY needs a credit line). */
export const ASSET_LICENSES = [
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'OFL-1.1',
  'Apache-2.0',
  'MIT',
  'own-work',
] as const

/** assets/credits.json: one entry per file in assets/ (paths relative to assets/). */
export const CreditsSchema = z.array(
  z
    .strictObject({
      file: relPath,
      license: z.enum(ASSET_LICENSES),
      credit: z.string().trim().min(1).max(200).optional(),
      source: z.string().trim().min(1).max(300).optional(),
    })
    .refine((c) => !c.license.startsWith('CC-BY') || c.credit, {
      message: 'CC BY needs a credit',
      path: ['credit'],
    }),
)
export type Credits = z.infer<typeof CreditsSchema>

/** One look in the catalog the build writes (app/server/generated/looks.ts), shared by the server and the UI. */
export interface LookCatalogEntry {
  id: string
  name: string
  description: string
  tags: string[]
  bestFor: LookJson['bestFor']
  aspects: LookJson['aspects']
  engines: LookJson['engines']
  recording: LookJson['recording'] | null
  /** sound.musicMood, for the music pick. */
  musicMood: string | null
  /** lookHash of the run files; the archive's sha256 and size. */
  hash: string
  sha256: string
  bytes: number
  source: 'builtin' | 'team'
  /** Paths under the site root, content-hashed and served immutable (/assets/*), or null without a preview. */
  preview: { mp4: string | null; poster: string | null }
}
