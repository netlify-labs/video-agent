// The docs page's tool and prompt lists (src/mcp-catalog.ts) must match what the MCP server registers for each role.
import { describe, expect, it } from 'vitest'
import type { Role } from '../src/domain/types.js'
import { MCP_PROMPTS, MCP_TOOLS, type McpAccess, type McpCatalogEntry } from '../src/mcp-catalog.js'
import { apiKey, harness, mcpCall, person } from './helpers.js'

const SEES: Record<McpAccess, Role[]> = {
  everyone: ['admin', 'creator', 'reviewer', 'viewer'],
  reviewers: ['admin', 'creator', 'reviewer'],
  creators: ['admin', 'creator'],
  planning: ['admin', 'creator'],
}

const expected = (entries: readonly McpCatalogEntry[], role: Role) =>
  entries
    .filter((e) => SEES[e.access].includes(role))
    .map((e) => e.name)
    .sort()

describe('MCP catalog', () => {
  it('has no duplicate names', () => {
    for (const list of [MCP_TOOLS, MCP_PROMPTS]) {
      const names = list.map((e) => e.name)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it.each<Role>(['admin', 'creator', 'reviewer', 'viewer'])(
    'lists exactly the tools and prompts a %s gets',
    async (role) => {
      const h = harness()
      const cookie = role === 'admin' ? h.admin : await person(h, `u_${role}`, role)
      const key = await apiKey(h, cookie)
      const { tools } = (await mcpCall(h, key, 'tools/list', {})) as { tools: { name: string }[] }
      const { prompts } = (await mcpCall(h, key, 'prompts/list', {})) as { prompts: { name: string }[] }
      expect(tools.map((t) => t.name).sort()).toEqual(expected(MCP_TOOLS, role))
      expect(prompts.map((p) => p.name).sort()).toEqual(expected(MCP_PROMPTS, role))
    },
  )

  it('drops the planning tools when AI Gateway is off', async () => {
    const h = harness()
    h.deps.gateway.isAvailable = false
    const { tools } = (await mcpCall(h, await apiKey(h, h.admin), 'tools/list', {})) as {
      tools: { name: string }[]
    }
    expect(tools.map((t) => t.name).sort()).toEqual(
      MCP_TOOLS.filter((t) => t.access !== 'planning')
        .map((t) => t.name)
        .sort(),
    )
  })
})
