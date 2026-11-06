// Spike A2: no dependencies, so the committed dist/ is the whole action.
const fs = require('node:fs')

const greeting = process.env['INPUT_GREETING'] ?? ''
console.log(`video-agent spike A2: greeting=${JSON.stringify(greeting)} node=${process.version}`)
console.log(`action path: ${process.env.GITHUB_ACTION_PATH ?? '(unset)'} ref: ${process.env.GITHUB_ACTION_REF ?? '(unset)'}`)
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `node=${process.version}\n`)
