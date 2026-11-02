// The Deploy to Netlify form lets the three required settings be skipped. The public config says which are still
// missing (names only), so the sign-in screen and the app can show what to add.
import { describe, expect, it } from 'vitest'
import { harness } from './helpers.js'

const missing = async (env: Record<string, string>) => {
  const h = harness(env)
  return (await h.json<{ missingSettings: string[] }>(await h.call('GET', '/api/v1/config'))).missingSettings
}

describe('missing settings', () => {
  it('lists the required settings a deployment skipped, and none once they are set', async () => {
    expect(await missing({})).toEqual([])
    expect(await missing({ RUNNER_API_TOKEN: '', ALLOWED_EMAIL_DOMAINS: '', ADMIN_EMAILS: '' })).toEqual([
      'RUNNER_API_TOKEN',
      'ALLOWED_EMAIL_DOMAINS',
      'ADMIN_EMAILS',
    ])
    expect(await missing({ RUNNER_API_TOKEN: '' })).toEqual(['RUNNER_API_TOKEN'])
    // invite-only is a choice, not a missing setting.
    expect(await missing({ ALLOWED_EMAIL_DOMAINS: 'invite-only' })).toEqual([])
  })

  it('never includes the values', async () => {
    const body = await (
      await harness({ RUNNER_API_TOKEN: 'secret-token-value' }).call('GET', '/api/v1/config')
    ).text()
    expect(body).not.toContain('secret-token-value')
  })
})
