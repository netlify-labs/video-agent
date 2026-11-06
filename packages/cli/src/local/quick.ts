// The Quick demo's adapter (local demo --quick; va-rsk5.5.4): runs runtime/quick-agent.mjs, which runs the Quick demo
// prompt's fixed commands without a model. Same env allowlist as a real agent; nothing it runs is authored.
import { join } from 'node:path'
import { agentEnv, type Adapter } from './agent.js'

export const quick: Adapter = {
  id: 'quick',
  command({ ws, env }) {
    const runtime = env.VA_RUNTIME
    if (!runtime) throw new Error('VA_RUNTIME is not set (the workspace sets it)')
    return {
      cmd: process.execPath,
      args: [join(runtime, 'quick-agent.mjs'), join(ws, 'prompt.txt')],
      env: agentEnv(env),
    }
  },
}
