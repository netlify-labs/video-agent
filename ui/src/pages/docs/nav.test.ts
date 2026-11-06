// Every docs nav entry has a route and a preload entry; every docs route is in the nav.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DOCS_GROUPS, DOCS_PAGES } from './nav'

const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../../routes.tsx', import.meta.url), 'utf8')

describe('docs nav', () => {
  it('every entry has a route in App.tsx and a module in routes.tsx BY_PATH', () => {
    for (const p of DOCS_PAGES) {
      expect(app, p.path).toContain(`path="${p.path}"`)
      expect(routes, p.path).toContain(`'${p.path}':`)
    }
  })

  it('every /docs/<page> route is in the nav', () => {
    const routed = [...app.matchAll(/path="(\/docs\/[a-z-]+)"/g)].map((m) => m[1])
    expect(routed.sort()).toEqual(DOCS_PAGES.map((p) => p.path).sort())
  })

  it('paths are unique and every group is known', () => {
    expect(new Set(DOCS_PAGES.map((p) => p.path)).size).toBe(DOCS_PAGES.length)
    for (const p of DOCS_PAGES) expect(DOCS_GROUPS).toContain(p.group)
  })
})
