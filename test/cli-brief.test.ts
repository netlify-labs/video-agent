// video-agent brief pr|release|changelog (github-action plan §7.2; bead va-mg4i.2.6): the GitHub Action's briefs from
// the command line, read from a stand-in GitHub API through the CLI's fetch, printed for `create --prompt-file -`.
import { describe, expect, it } from 'vitest'
import { cli } from './cli-io.js'
import { harness } from './helpers.js'

const PR = {
  title: 'Webhooks: retry failed deliveries',
  body: '<!-- template -->\nAdds a Retry button.\n\nFailed deliveries used to need a ticket.',
  html_url: 'https://github.com/acme/web/pull/123',
  changed_files: 2,
}

/** A stand-in for api.github.com: the routes the brief commands read. */
function github(req: Request): Response {
  const u = new URL(req.url)
  if (u.host !== 'api.github.com') return new Response('not found', { status: 404 })
  const p = u.pathname
  if (p === '/repos/acme/web/pulls/123') return Response.json(PR)
  if (p === '/repos/acme/web/pulls/123/commits')
    return Response.json([{ commit: { message: 'feat: retry button' } }])
  if (p === '/repos/acme/web/pulls/123/files')
    return Response.json([{ filename: 'app/routes/webhooks.tsx' }, { filename: 'package-lock.json' }])
  if (p === '/repos/acme/web/releases/tags/v2.4.0')
    return Response.json({
      name: 'Spring',
      body: '- Retry failed deliveries\n- One webhook per org',
      html_url: 'https://github.com/acme/web/releases/tag/v2.4.0',
    })
  if (p === '/search/issues')
    return Response.json({
      items: [
        { number: 130, title: 'Faster deploy previews' },
        { number: 131, title: 'Org webhooks' },
      ],
    })
  return Response.json({ message: 'Not Found' }, { status: 404 })
}

describe('video-agent brief', () => {
  it('brief pr prints the action’s PR brief, ending with the reference line', async () => {
    const c = await cli(harness(), { other: github })
    const r = await c.run([
      'brief',
      'pr',
      'https://github.com/acme/web/pull/123',
      '--prompt',
      'For sales engineers.',
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('A demo video of a new change in web')
    expect(r.stdout).toContain('For sales engineers.')
    expect(r.stdout).toContain('Failed deliveries used to need a ticket.')
    expect(r.stdout).not.toContain('template')
    expect(r.stdout.trimEnd().endsWith('[va-ref github:acme/web#pr-123]')).toBe(true)
    // No token in the environment: none sent.
    expect(
      c.requests
        .filter((q) => q.url.startsWith('https://api.github.com'))
        .every((q) => !q.headers.has('authorization')),
    ).toBe(true)
  })

  it('--json gives the whole brief; --context moves the PR text into a context block; --untrusted drops it', async () => {
    const c = await cli(harness(), { other: github })
    const j = (await c.run(['brief', 'pr', 'https://github.com/acme/web/pull/123', '--json'])).json()
    expect(j).toMatchObject({
      title: 'PR #123: Webhooks: retry failed deliveries',
      reference: '[va-ref github:acme/web#pr-123]',
      durationSec: 30,
    })
    const withContext = (
      await c.run(['brief', 'pr', 'https://github.com/acme/web/pull/123', '--context', '--json'])
    ).json()
    expect(withContext.context).toMatchObject({
      source: 'github_pr',
      label: 'GitHub PR #123',
      url: PR.html_url,
    })
    expect(withContext.prompt).not.toContain('Failed deliveries')
    const untrusted = await c.run(['brief', 'pr', 'https://github.com/acme/web/pull/123', '--untrusted'])
    expect(untrusted.stdout).not.toContain('Failed deliveries')
    expect(untrusted.stdout).toContain('Title: Webhooks: retry failed deliveries')
  })

  it('brief release reads the release from GitHub, or the notes from stdin', async () => {
    const c = await cli(harness(), { other: github, stdin: '## Changes\n- From a file\n' })
    const gh = await c.run(['brief', 'release', 'v2.4.0', '--repo', 'acme/web'])
    expect(gh.code).toBe(0)
    expect(gh.stdout).toContain('Release: Spring (v2.4.0)')
    expect(gh.stdout).toContain('- One webhook per org')
    expect(gh.stdout.trimEnd().endsWith('[va-ref github:acme/web@v2.4.0]')).toBe(true)
    const file = await c.run(['brief', 'release', 'v2.5.0', '--repo', 'acme/web', '--notes-file', '-'])
    expect(file.stdout).toContain('- From a file')
  })

  it('brief changelog lists merged PRs; mistakes are usage errors and missing things exit 4', async () => {
    const c = await cli(harness(), { other: github })
    const r = await c.run(['brief', 'changelog', '--since', '2026-11-01', '--repo', 'acme/web'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('- #130 Faster deploy previews')
    expect((await c.run(['brief', 'changelog', '--repo', 'acme/web'])).code).toBe(2)
    expect((await c.run(['brief', 'release', 'v1'])).code).toBe(2)
    expect((await c.run(['brief', 'pr', 'https://example.com/x'])).code).toBe(2)
    const missing = await c.run(['brief', 'release', 'v9', '--repo', 'acme/web'])
    expect(missing.code).toBe(4)
  })
})
