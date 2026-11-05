// The deploy's looks (plan 2026-11-04-looks §4.3, §4.8): the catalog the build wrote into src/generated/looks.ts, and
// the archives it packed into looks-build/, which the API function carries ([functions."api"] included_files). The
// function's working directory is the bundle root on Netlify and the project root locally (docs/spikes.md K3).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LooksPort } from '../deps.js'
import { looksCatalog } from '../generated/looks.js'
import { LOOK_ID } from '../lib/looks.js'

export const builtinLooks: LooksPort = {
  catalog: () => looksCatalog,
  archive: async (id) => {
    if (!LOOK_ID.test(id)) throw new Error(`Not a look id: ${id}`)
    return new Uint8Array(await readFile(join(process.cwd(), 'looks-build', `${id}.tar.gz`)))
  },
}
