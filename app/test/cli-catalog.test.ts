// The CLI's command catalog stays in step with the server and the SDK (cli-and-sdk plan §6.1), like
// app/test/mcp-catalog.test.ts does for the MCP tools.
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../../packages/cli/src/catalog.js'
import { HANDLERS } from '../../packages/cli/src/router.js'
import { VideoAgent } from '../../packages/sdk/src/index.js'
import { FEATURES } from '../server/domain/features.js'

const va = new VideoAgent({ url: 'https://video.example.com', apiKey: 'nva_x', fetch: (() => {}) as never })
const sdkHas = (name: string) => {
  if (name === 'raw') return true
  const [r, m] = name.split('.') as [string, string]
  return typeof (va as unknown as Record<string, Record<string, unknown> | undefined>)[r]?.[m] === 'function'
}

describe('CLI catalog', () => {
  it('names are unique', () => {
    const names = COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every feature a command needs is one the server can list', () => {
    for (const c of COMMANDS) if (c.feature) expect(FEATURES, c.name).toContain(c.feature)
  })

  it('every ready command has a handler and calls SDK methods that exist', () => {
    for (const c of COMMANDS.filter((x) => x.ready)) {
      expect(HANDLERS[c.name], c.name).toBeTypeOf('function')
      for (const m of c.sdk) expect(sdkHas(m), `${c.name}: ${m}`).toBe(true)
    }
  })

  it('every handler is a ready catalog command', () => {
    for (const name of Object.keys(HANDLERS))
      expect(COMMANDS.find((c) => c.name === name)?.ready, name).toBe(true)
  })
})
