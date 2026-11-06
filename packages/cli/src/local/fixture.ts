// The fixture agent's adapter (bead va-p1th.5.14; hidden --agent fixture): runs runtime/fixture-agent.mjs, which does
// what the prompt says without a model, for local mode's CI and tests. Same env allowlist as a real agent; no sandbox.
import { join } from 'node:path'
import { agentEnv, type Adapter } from './agent.js'

export const fixture: Adapter = {
  id: 'fixture',
  command({ ws, env }) {
    const runtime = env.VA_RUNTIME
    if (!runtime) throw new Error('VA_RUNTIME is not set (the workspace sets it)')
    return {
      cmd: process.execPath,
      args: [join(runtime, 'fixture-agent.mjs'), join(ws, 'prompt.txt')],
      env: agentEnv(env),
    }
  },
}
