// Starts a new look from looks/_template (plan 2026-11-04-looks §8 step 1).
//   npm run look:new <id>
// Copies the template to looks/<id>/ and fills look.json's id, name and since. Refuses a bad id or an existing folder.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOOK_ID } from '../src/lib/looks.js'
import { repoRoot } from './lib/run-tools.js'

export class LookNewError extends Error {}

/** `retro-crt` → `Retro crt`. */
const nameOf = (id: string) => (id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ')).slice(0, 40)

export function newLook(looksDir: string, id: string, today: string): string {
  if (!LOOK_ID.test(id))
    throw new LookNewError(
      `"${id}" isn't a look id: lowercase letters, digits and dashes, up to 40, starting with a letter or digit.`,
    )
  const dir = join(looksDir, id)
  if (existsSync(dir)) throw new LookNewError(`looks/${id} already exists.`)
  cpSync(join(looksDir, '_template'), dir, { recursive: true })
  const path = join(dir, 'look.json')
  const look = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  writeFileSync(path, JSON.stringify({ ...look, id, name: nameOf(id), since: today }, null, 2) + '\n')
  return dir
}

if (process.argv[1]?.endsWith('look-new.ts')) {
  const id = process.argv[2] ?? ''
  try {
    newLook(join(repoRoot, 'looks'), id, new Date().toISOString().slice(0, 10))
  } catch (e) {
    if (!(e instanceof LookNewError)) throw e
    console.error(e.message)
    process.exit(1)
  }
  console.log(`Made looks/${id}. Next:
  1. Write looks/${id}/LOOK.md and build looks/${id}/example/ (fictional product "Orbit", placeholder words).
  2. List registry items in look.json, components first, then: npm run look:vendor ${id}
  3. npm run look:check -- --static ${id}   (until it passes)
  4. Render preview.mp4 and poster.webp (looks/README.md has the commands).
  5. Try it on real prompts: video-agent local --look ./looks/${id} "<prompt>"`)
}
