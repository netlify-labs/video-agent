// Checks video/ against the editing contract v1 (plan v2 §8): the same validator the editor and render-job use.
//   npx tsx scripts/check-contract.ts [--fix]      (--duck is the old name of --fix)
// Prints each violation and exits 1, or prints "Contract v1: OK". With a recorded narration bus in video/ (mixed in this
// run, or a narrated parent's), the composition must also last as long as the bus (in a fit: the frozen target).
// --fix first rewrites what it can: the music's ducking lane (data-va-duck), which a run with locked narration can't edit
// by hand (plan 2026-11-02 §6.4), and in a scoped revision (redo a scene) the splice, which re-lays the scenes and puts
// back everything outside the scope, saying what it put back. The logic is scripts/lib/check-contract.ts.
import { checkContract, fixFlag } from './lib/check-contract.js'
import { repoRoot } from './lib/run-tools.js'

const { lines, code } = checkContract(repoRoot, { fix: fixFlag(process.argv) })
for (const line of lines) console.log(line)
process.exit(code)
