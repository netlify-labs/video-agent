// The share page's Remix link (docs/plans/2026-11-03-remix.md §3.7; bead va-p62w.4.5): the page is the same for
// everyone, with the link hidden; one small script reveals it for a signed-in teammate who can remix, and only asks the
// app when the app's non-secret va_creator hint cookie is present (the public's views never call the API).
import { describe, expect, it, vi } from 'vitest'
import type { TestDeps } from './fakes.js'
import { harness, readyVideo } from './helpers.js'
import { loadEdge } from './edge.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

describe('share page remix link', () => {
  it('is in the page, hidden, pointing at the video page with ?remix, behind the hint cookie', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h, h.member)
    const pub = await h.json<{ slug: string }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member }),
    )
    const page = await (
      await (
        await loadEdge('public')
      )(new Request(`https://video.example.com/v/${pub.slug}`), {
        deploy: { published: true },
      })
    ).text()
    expect(page).toContain(
      `<a class="remix" data-remix hidden href="/videos/${id}?remix=1">Remix in Video Agent</a>`,
    )
    // The script checks the embed case and the hint cookie before any request.
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? ''
    expect(script).toContain('window.top!==window')
    expect(script.indexOf('va_creator=1')).toBeLessThan(script.indexOf("fetch('/api/v1/me'"))
    expect(script).toContain('remixEnabled')
    // Only one script on the page.
    expect(page.match(/<script>/g)).toHaveLength(1)
  })

  it('the script reveals the link only for creators and admins with remixing on, and never calls without the cookie', async () => {
    const h = harness()
    current = h.deps
    const id = await readyVideo(h, h.member)
    const pub = await h.json<{ slug: string }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member }),
    )
    const page = await (
      await (
        await loadEdge('public')
      )(new Request(`https://video.example.com/v/${pub.slug}`), {
        deploy: { published: true },
      })
    ).text()
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? ''
    const run = async (o: { cookie: string; role: string; remixEnabled: boolean; framed?: boolean }) => {
      const link = { hidden: true }
      const calls: string[] = []
      const win: { top: unknown } = { top: null }
      win.top = o.framed ? {} : win
      const fetchFake = async (url: string) => {
        calls.push(url)
        const body = url.endsWith('/me') ? { role: o.role } : { remixEnabled: o.remixEnabled }
        return { ok: true, json: async () => body }
      }
      const doc = { cookie: o.cookie, querySelector: () => link }
      // The page's own inline script, run against fakes: it's the code under test, from our own edge function.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function('window', 'document', 'fetch', script)(win, doc, fetchFake)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      return { shown: !link.hidden, calls }
    }
    expect(await run({ cookie: '', role: 'creator', remixEnabled: true })).toEqual({
      shown: false,
      calls: [],
    })
    expect(await run({ cookie: 'x=1; va_creator=1', role: 'creator', remixEnabled: true })).toMatchObject({
      shown: true,
    })
    expect(await run({ cookie: 'va_creator=1', role: 'admin', remixEnabled: true })).toMatchObject({
      shown: true,
    })
    expect(await run({ cookie: 'va_creator=1', role: 'viewer', remixEnabled: true })).toMatchObject({
      shown: false,
    })
    expect(await run({ cookie: 'va_creator=1', role: 'creator', remixEnabled: false })).toMatchObject({
      shown: false,
    })
    expect(await run({ cookie: 'va_creator=1', role: 'creator', remixEnabled: true, framed: true })).toEqual({
      shown: false,
      calls: [],
    })
    // A cookie whose name only ends in va_creator doesn't count.
    expect(await run({ cookie: 'not_va_creator=1', role: 'creator', remixEnabled: true })).toEqual({
      shown: false,
      calls: [],
    })
  })
})
