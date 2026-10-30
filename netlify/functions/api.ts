import { handle } from '@hono/netlify'
import type { Config } from '@netlify/functions'
import { createApp, type NetlifyContext } from '../../src/app.js'
import { prodDeps } from '../../src/adapters/prod.js'
import { contextMeta } from '../../src/generated/context.js'

const app = createApp(prodDeps(), {
  isLive: (ctx: NetlifyContext | undefined) =>
    ctx?.deploy?.published === true || process.env.ALLOW_NON_PRODUCTION === 'true',
  contextIsDefault: contextMeta.isDefault,
})

export default handle(app)

export const config: Config = { path: ['/api/*', '/mcp'] }
