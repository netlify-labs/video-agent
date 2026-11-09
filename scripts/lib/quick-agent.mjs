#!/usr/bin/env node
// The Quick demo's agent for `video-agent local demo --quick` (screen-recording plan §6.3; va-rsk5.5.4): the Quick demo
// prompt (app/server/domain/prompt.ts buildQuickDemoPrompt) is a fixed list of commands with no authoring, so this runs them
// in order without a model: prepare-run, recording.ts analyze, plan and compose, check-contract, hyperframes check (in
// video/), render-job. It stops at the first that fails, as the prompt tells an agent to.
//   node quick-agent.mjs <ws>/prompt.txt
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const prompt = readFileSync(process.argv[2], 'utf8')
const ws = process.env.VA_REPO_ROOT ?? process.cwd()
// "N. Run: <command>": the command up to the line's end (step 5 is check-contract, then hyperframes check).
const steps = [...prompt.matchAll(/^\d+\. Run: (.+)$/gm)].map((m) => m[1].trim())
if (!steps.length) throw new Error('The prompt has no "Run:" steps: is it a Quick demo prompt?')
const sh = (cmd, cwd = ws) => {
  process.stdout.write(`$ ${cmd.slice(0, 160)}\n`)
  execSync(cmd, { cwd, stdio: 'inherit', env: process.env })
}
for (const step of steps) {
  if (step.startsWith('npx tsx scripts/check-contract.ts')) {
    sh('npx tsx scripts/check-contract.ts')
    sh('npx hyperframes check', join(ws, 'video'))
  } else sh(step.replace(/[.]$/, ''))
}
process.stdout.write('quick agent: done\n')
