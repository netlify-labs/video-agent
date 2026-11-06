#!/usr/bin/env node
// The fixture agent (bead va-p1th.5.14): a deterministic stand-in for a coding agent, for local mode's CI and tests.
// It does what the prompt asks without a model: runs its prepare-run command, writes a known-good composition (the
// contract1 fixture shipped next to this file), posts a checkpoint, and runs its render-job command.
//   node fixture-agent.mjs <ws>/prompt.txt
import { execSync } from 'node:child_process'
import { copyFileSync, cpSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const prompt = readFileSync(process.argv[2], 'utf8')
const here = dirname(fileURLToPath(import.meta.url))
const ws = process.env.VA_REPO_ROOT ?? process.cwd()
/** The prompt's command for a script: its --flag value pairs only (the prose after it is not part of it). */
const command = (script) => {
  const m = new RegExp(`npx tsx scripts/${script}\\.ts((?: --[a-z-]+ [^\\s\`]+)+)`).exec(prompt)
  if (!m) throw new Error(`The prompt has no ${script} command`)
  // A --message is the prompt's placeholder: the caller adds its own.
  return `npx tsx scripts/${script}.ts${m[1].replace(/ --message .*$/, '').replace(/[.,;:]$/, '')}`
}
const sh = (cmd) => {
  process.stdout.write(`$ ${cmd.slice(0, 120)}\n`)
  execSync(cmd, { cwd: ws, stdio: 'inherit', env: process.env })
}

sh(command('prepare-run'))
for (const f of ['index.html', 'summary.json']) copyFileSync(join(here, 'fixture', f), join(ws, 'video', f))
cpSync(join(here, 'fixture', 'assets'), join(ws, 'video', 'assets'), { recursive: true })
sh(`${command('checkpoint')} --message "Fixture composition in place"`)
sh(command('render-job'))
process.stdout.write('fixture agent: done\n')
