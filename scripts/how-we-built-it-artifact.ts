// Writes the employees' copy of ui/static/how-we-built-it/ for the netlify-artifacts skill to publish (all-employees team,
// artifact-netlify-video-agent): the same page, with links to the app made absolute since it's served from another site.
// Usage: npx tsx scripts/how-we-built-it-artifact.ts [outDir] [appUrl]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from './lib/run-tools.js'

const out = process.argv[2] ?? join(homedir(), 'netlify-artifacts', 'artifact-netlify-video-agent')
const app = (process.argv[3] ?? 'https://netlify-video-agent.netlify.app').replace(/\/$/, '')

const page = readFileSync(join(repoRoot, 'ui/static/how-we-built-it/index.html'), 'utf8')
  .replace('<html lang="en" data-site="">', `<html lang="en" data-site="${app}">`)
  // Root-relative links and media (href="/new", data-src="/v/…") point at the app; #anchors stay on the page.
  .replace(/\b(href|src|data-src|data-poster|data-captions)="\/(?!\/)/g, `$1="${app}/`)
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'index.html'), page)
console.log(`Wrote ${join(out, 'index.html')} (links to ${app})`)
