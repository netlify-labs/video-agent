// Generates what the service knows about the Remotion template (render-engines plan §5.1), from
// engines/remotion/template, with no Remotion installed:
//   src/lib/remotion-locked.json        { remotion, files: { path: sha256 } } for every template-owned file
//   src/lib/remotion-props.schema.json  props.json's JSON Schema, from the template's src/va/schema.ts (zod 4)
//   engines/remotion/template/src/registry.ts, from the starter props.json
//   npx tsx scripts/gen-remotion-locked.ts [--check]   (--check: exit 1 if any of them is stale)
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { vaSchema } from '../engines/remotion/template/src/va/schema.js'
import { generateRegistry } from '../src/lib/remotion-project.js'

const root = join(import.meta.dirname, '..')
const template = join(root, 'engines', 'remotion', 'template')
const check = process.argv.includes('--check')

/** The files the template owns: the wiring, the package set, the va/ runtime and AGENTS.md. */
export const LOCKED_PATHS = [
  'AGENTS.md',
  'package.json',
  'package-lock.json',
  'remotion.config.ts',
  'tsconfig.json',
  'src/index.ts',
  'src/Root.tsx',
  ...readdirSync(join(template, 'src', 'va'))
    .map((f) => `src/va/${f}`)
    .sort(),
]

const pkg = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}
const outputs: [string, string][] = [
  [
    join(template, 'src', 'registry.ts'),
    generateRegistry(
      JSON.parse(readFileSync(join(template, 'props.json'), 'utf8')) as Parameters<
        typeof generateRegistry
      >[0],
    ),
  ],
  [
    join(root, 'src', 'lib', 'remotion-locked.json'),
    `${JSON.stringify(
      {
        remotion: pkg.dependencies.remotion,
        files: Object.fromEntries(
          LOCKED_PATHS.map((p) => [
            p,
            createHash('sha256')
              .update(readFileSync(join(template, p)))
              .digest('hex'),
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  ],
  [
    join(root, 'src', 'lib', 'remotion-props.schema.json'),
    `${JSON.stringify(z.toJSONSchema(vaSchema), null, 2)}\n`,
  ],
]
const stale: string[] = []
for (const [file, body] of outputs) {
  let was: string
  try {
    was = readFileSync(file, 'utf8')
  } catch {
    was = ''
  }
  if (was === body) continue
  stale.push(relative(root, file))
  if (!check) writeFileSync(file, body)
}
if (check && stale.length) {
  console.error(`Stale: ${stale.join(', ')}. Run npx tsx scripts/gen-remotion-locked.ts`)
  process.exit(1)
}
console.log(stale.length ? `Wrote ${stale.join(', ')}` : 'Up to date')
