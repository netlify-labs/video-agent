// video-agent media upload|list|get, api and keys against the real routes (beads va-p1th.4.9, va-p1th.4.10).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../packages/cli/src/exit.js'
import { cli, SITE } from './cli-io.js'
import { harness } from './helpers.js'

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
/** The fixture clip padded with a trailing `free` box: a valid 9 MB MP4 that needs an upload session. */
function bigClip(total = 9 * 1024 * 1024) {
  const clip = fixture('a169.mp4')
  const out = new Uint8Array(total)
  out.set(clip)
  new DataView(out.buffer).setUint32(clip.byteLength, total - clip.byteLength)
  out.set(new TextEncoder().encode('free'), clip.byteLength + 4)
  return out
}
const file = (name: string, bytes: Uint8Array) => {
  const p = join(mkdtempSync(join(tmpdir(), 'va-media-')), name)
  writeFileSync(p, bytes)
  return p
}

describe('video-agent media', () => {
  it('uploads a small and a multi-part file, waits for ready, and lists and gets them', async () => {
    const h = harness()
    const { run } = await cli(h)
    const small = file('clip.mp4', fixture('a169.mp4'))
    const big = file('big.mp4', bigClip())
    const r = await run(['media', 'upload', small, big, '--caption', 'Launch clip', '--json'])
    expect(r.code).toBe(0)
    const items = r.json().items as { id: string; status: string; filename: string }[]
    expect(items.map((i) => [i.filename, i.status])).toEqual([
      ['clip.mp4', 'ready'],
      ['big.mp4', 'ready'],
    ])
    const human = await run(['media', 'upload', small])
    expect(human.stderr).toContain('clip.mp4: ')
    const list = await run(['media', 'list', '--kind', 'video', '--json'])
    expect(list.json().items.map((m: { id: string }) => m.id)).toEqual(
      expect.arrayContaining(items.map((i) => i.id)),
    )
    const got = await run(['media', 'get', items[0]?.id ?? '', '--json'])
    expect(got.json()).toMatchObject({ id: items[0]?.id, caption: 'Launch clip' })
  })

  it('a rejected file exits 1 with the reason', async () => {
    const h = harness()
    const { run } = await cli(h)
    const r = await run(['media', 'upload', file('bad.mp4', fixture('truncated.mp4')), '--json'])
    expect([EXIT.error, EXIT.usage]).toContain(r.code)
    expect(r.json().error.message.length).toBeGreaterThan(0)
  })
})

describe('video-agent api and keys', () => {
  it('calls any route with GET and POST, and reads --data from a file', async () => {
    const h = harness()
    const { run } = await cli(h)
    const me = await run(['api', 'GET', '/api/v1/me', '--json'])
    expect(me.json().id).toBe('u_member')
    const body = file('plan.json', new TextEncoder().encode(JSON.stringify({ name: 'From the CLI' })))
    const post = await run(['api', 'post', '/api/v1/keys', '--data', `@${body}`, '--json'])
    // Keys can't make keys (src/domain/keys.ts): the server's own refusal comes back as is.
    expect(post.code).toBe(EXIT.notFound)
    expect(post.json().error.code).toBe('forbidden')
    expect((await run(['api', 'FETCH', '/api/v1/me'])).code).toBe(EXIT.usage)
    expect((await run(['api', 'GET', '/api/v1/me', '--data', '{nope'])).code).toBe(EXIT.usage)
  })

  it('lists and revokes keys; keys create explains where keys come from', async () => {
    const h = harness()
    const { run } = await cli(h)
    const list = await run(['keys', 'list', '--json'])
    const keys = list.json().items as { id: string }[]
    expect(keys).toHaveLength(1)
    const create = await run(['keys', 'create'])
    expect(create.code).toBe(EXIT.usage)
    expect(create.stderr).toContain(`${SITE}/keys`)
    expect(create.stderr).toContain('video-agent login')
    const revoke = await run(['keys', 'revoke', keys[0]?.id ?? '', '--json'])
    expect(revoke.json()).toEqual({ id: keys[0]?.id, revoked: true })
    // That was the key this CLI used: the next call is refused.
    expect((await run(['keys', 'list'])).code).toBe(EXIT.auth)
  })
})
