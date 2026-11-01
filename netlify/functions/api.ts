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

// The OAuth paths answer only when MCP OAuth is configured, and /auth/* only with Sign in with Netlify (src/auth);
// otherwise they 404.
export const config: Config = {
  path: [
    '/api/*',
    '/mcp',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/*',
    '/.well-known/oauth-authorization-server',
    '/oauth/*',
    '/auth/*',
  ],
}
