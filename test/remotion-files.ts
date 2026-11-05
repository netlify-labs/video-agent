// The Remotion template as a project's files (path -> bytes), the way a run or finalize sees them: no node_modules.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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
