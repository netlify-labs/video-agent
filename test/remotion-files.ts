// The Remotion template as a project's files (path -> bytes), the way a run or finalize sees them: no node_modules.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Entry } from './tarball.js'

export const template = join(import.meta.dirname, '..', 'engines', 'remotion', 'template')

export function templateFiles(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (n === 'node_modules') continue
      if (statSync(p).isDirectory()) walk(p)
      else out.set(relative(template, p), new Uint8Array(readFileSync(p)))
    }
  }
  walk(template)
  return out
}

/** The template as render-job archives it (under video/), with changes: a path set to null is left out. */
export function remotionBundle(changes: Record<string, string | null> = {}): Entry[] {
  const files = templateFiles()
  for (const [p, body] of Object.entries(changes))
    if (body === null) files.delete(p)
    else files.set(p, new TextEncoder().encode(body))
  return [...files].map(([p, body]) => ({ name: `video/${p}`, body }))
}
