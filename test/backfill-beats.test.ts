// Backfilling versions.beats (redo a scene, plan §4.2): only ready contract-v1 versions without beats are filled,
// a re-run fills nothing, and a dry run writes nothing.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { backfillBeats } from '../scripts/backfill-beats.js'
import { load, save } from '../src/lib/contract.js'
import { harness, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)

async function video(h: Harness, html: string) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: html },
    { name: 'video/summary.json', body: '{"captions":[]}' },
  ])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}

describe('scripts/backfill-beats.ts', () => {
  it('fills only ready contract versions without beats, once; a dry run writes nothing', async () => {
    const h = harness()
    const a = await video(h, music)
    const b = await video(h, music)
    const plain = await video(h, '<!doctype html><html><body>No contract here.</body></html>')
    await h.deps.store.updateVersion(a, 1, { beats: null })
    const call = async (method: string, path: string) => {
      const res = await h.call(method, path, { as: h.admin })
      return { status: res.status, json: await h.json(res) }
    }
    const events: string[] = []
    const log = (step: string) => events.push(step)

    expect(await backfillBeats(call, { dryRun: true, log })).toEqual({ filled: 1, failed: 0 })
    expect(events).toContain('version.would_fill')
    expect((await h.deps.store.getVersion(a, 1))?.beats).toBeNull()

    expect(await backfillBeats(call, { log })).toEqual({ filled: 1, failed: 0 })
    expect((await h.deps.store.getVersion(a, 1))?.beats?.map((x) => x.id)).toEqual(['intro', 'demo', 'outro'])
    expect((await h.deps.store.getVersion(b, 1))?.beats).toHaveLength(3)
    expect((await h.deps.store.getVersion(plain, 1))?.beats).toBeNull()

    // Safe to re-run.
    expect(await backfillBeats(call, { log })).toEqual({ filled: 0, failed: 0 })
  })
})
