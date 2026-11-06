// Revising with a scope (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.1): every rule and its message, the
// stored scope in the parent's order, and the lazy scene fill before the transaction.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerScopeCheck, resetScopeChecks } from '../src/domain/engines.js'
import type { Principal } from '../src/domain/policy.js'
import { reviseVideo, type ReviseInput } from '../src/domain/videos.js'
import { applyHoldFrame, load, save } from '../src/lib/contract.js'
import { hyperframesScopeCheck } from '../src/lib/scope.js'
import type { Store } from '../src/store/types.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)
const person = (userId: string, role: Principal['role'] = 'creator'): Principal => ({
  kind: 'user',
  userId,
  email: `${userId}@acme.com`,
  name: userId,
  role,
  apiKeyId: null,
})
const mia = person('u_member')

beforeEach(() => registerScopeCheck('hyperframes', hyperframesScopeCheck))
afterEach(() => resetScopeChecks())

/** A ready contract-v1 video (scenes intro "Opening", demo, outro) owned by the harness member. */
async function parentVideo(h: Harness, html = music, extra: Record<string, Uint8Array | string> = {}) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: html },
    { name: 'video/summary.json', body: '{"captions":[]}' },
    ...Object.entries(extra).map(([p, body]) => ({ name: `video/${p}`, body })),
  ])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}
const revise = (h: Harness, id: string, input: Partial<ReviseInput>, who = mia, key?: string) =>
  reviseVideo(h.deps, who, id, { prompt: 'Make the headline say Ship on Friday.', ...input }, key)
const refusal = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message }
  }
  throw new Error('expected a refusal')
}

const stores: [string, () => Promise<Store | undefined>][] = [
  ['memory', async () => undefined],
  ['postgres', pgStore],
]
const opts = async (store: () => Promise<Store | undefined>) => {
  const s = await store()
  return s ? { store: s } : {}
}

describe.each(stores)('scoped revise (%s)', (_name, store) => {
  it('stores the scope de-duplicated and in the parent’s order, and logs it', async () => {
    const h = harness({ DEBUG_LEVEL: 'debug' }, await opts(store))
    const id = await parentVideo(h)
    await revise(h, id, { fromVersion: 1, scope: { beats: ['outro', 'intro', 'intro'] } })
    const v2 = await h.deps.store.getVersion(id, 2)
    expect(v2?.scope).toEqual({ beats: ['intro', 'outro'] })
    expect(v2?.parentN).toBe(1)
    expect(
      h.deps.logs.some(
        (l) => l.includes('video.revise_requested') && l.includes('"scope":["outro","intro","intro"]'),
      ),
    ).toBe(true)
  })

  it('fills an older parent’s scenes before the transaction, with no Blobs work inside it', async () => {
    const h = harness({}, await opts(store))
    const id = await parentVideo(h)
    await h.deps.store.updateVersion(id, 1, { beats: null })
    let inTx = 0
    const tx = h.deps.store.tx.bind(h.deps.store)
    h.deps.store.tx = async (f) => {
      inTx++
      try {
        return await tx(f)
      } finally {
        inTx--
      }
    }
    const gets: boolean[] = []
    const get = h.deps.blobs.get.bind(h.deps.blobs)
    h.deps.blobs.get = async (s, k) => {
      gets.push(inTx > 0)
      return get(s, k)
    }
    await revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } })
    expect(gets.length).toBeGreaterThan(0)
    expect(gets.every((x) => !x)).toBe(true)
    expect((await h.deps.store.getVersion(id, 1))?.beats?.map((b) => b.id)).toEqual([
      'intro',
      'demo',
      'outro',
    ])
    expect((await h.deps.store.getVersion(id, 2))?.scope).toEqual({ beats: ['demo'] })
  })
})

describe('scoped revise refusals', () => {
  it('refuses each rule with its message', async () => {
    const h = harness()
    const id = await parentVideo(h)
    const cases: [Partial<ReviseInput>, string, RegExp | string][] = [
      [
        { scope: { beats: ['demo'] } },
        'invalid_request',
        'Say which version the scenes are from (fromVersion): scene ids belong to one version.',
      ],
      [{ fromVersion: 1, scope: { beats: [] } }, 'invalid_request', 'Pick at least one scene to redo.'],
      [
        { fromVersion: 1, scope: { beats: Array.from({ length: 21 }, (_, i) => `b${i}`) } },
        'invalid_request',
        'Pick at most 20 scenes to redo.',
      ],
      [
        { fromVersion: 1, scope: { beats: ['Demo!'] } },
        'invalid_request',
        /lowercase letters, digits and dashes: "Demo!"/,
      ],
      [
        { fromVersion: 1, scope: { beats: ['feature'] } },
        'invalid_request',
        `There's no scene "feature". This video's scenes: intro (Opening), demo, outro.`,
      ],
      [
        { fromVersion: 1, scope: { beats: ['intro', 'demo', 'outro'] } },
        'invalid_request',
        "That's every scene: revise the whole video instead (leave out scope).",
      ],
      [
        { fromVersion: 1, scope: { beats: ['demo'] }, planId: 'pln_x' },
        'invalid_request',
        /leave out planId/,
      ],
      [
        { fromVersion: 1, scope: { beats: ['demo'] }, durationSec: 20 },
        'invalid_request',
        /leave out durationSec/,
      ],
      [{ fromVersion: 1, scope: { beats: ['demo'] }, sound: 'music' }, 'invalid_request', /leave out sound/],
      [
        {
          fromVersion: 1,
          scope: { beats: ['demo'] },
          voiceover: { enabled: false },
        },
        'invalid_request',
        /leave out voiceover/,
      ],
      [{ fromVersion: 7, scope: { beats: ['demo'] } }, 'not_found', 'Version 7 not found.'],
      // A look restyles every scene (looks plan §4.3), so it's never part of a scoped revision.
      [
        { fromVersion: 1, scope: { beats: ['demo'] }, look: 'any-look' },
        'look_not_allowed',
        "Redoing a scene keeps the video's look; pick a look with a full revision.",
      ],
    ]
    for (const [input, code, message] of cases) {
      const r = await refusal(revise(h, id, input))
      expect(r.code, JSON.stringify(input)).toBe(code)
      if (typeof message === 'string') expect(r.message).toBe(message)
      else expect(r.message).toMatch(message)
    }
    expect(await h.deps.store.getVersion(id, 2)).toBeNull()
  })

  it('refuses a version without the contract, a non-ready one, and an engine that can’t', async () => {
    const h = harness()
    const id = await parentVideo(h)
    await h.deps.store.updateVersion(id, 1, { contract: null })
    expect(await refusal(revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } }))).toEqual({
      code: 'not_editable',
      message:
        "Version 1 can't be edited scene by scene (it doesn't keep the editing contract). Revise the whole video instead.",
    })
    await h.deps.store.updateVersion(id, 1, { contract: 1, status: 'failed' })
    expect((await refusal(revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } }))).message).toMatch(
      /it isn't ready/,
    )
    await h.deps.store.updateVersion(id, 1, { status: 'ready', engine: 'remotion' })
    expect(await refusal(revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } }))).toEqual({
      code: 'not_editable',
      message:
        "Version 1 was made with Remotion, which can't redo scenes one by one yet. Revise the whole video instead.",
    })
  })

  it('refuses the held last frame and the scene it holds', async () => {
    const h = harness()
    const held = save(
      (() => {
        const d = load(music)
        applyHoldFrame(d, 1)
        return d
      })(),
    )
    const id = await parentVideo(h, held, { 'assets/hold/last.png': new Uint8Array([137, 80, 78, 71]) })
    expect((await h.deps.store.getVersion(id, 1))?.contract).toBe(1)
    for (const beats of [['va-hold'], ['outro']])
      expect((await refusal(revise(h, id, { fromVersion: 1, scope: { beats } }))).message).toBe(
        'This scene ends the video under your recorded narration and holds its last frame; redo it with a whole-video revision.',
      )
    await revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } })
    expect((await h.deps.store.getVersion(id, 2))?.scope).toEqual({ beats: ['demo'] })
  })

  it('refuses a scope while the server doesn’t offer it', async () => {
    const h = harness()
    const id = await parentVideo(h)
    resetScopeChecks()
    expect(await refusal(revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } }))).toEqual({
      code: 'invalid_request',
      message: "This server can't redo single scenes yet.",
    })
  })

  it('a private video someone can’t see is not found, with no Blobs work', async () => {
    const h = harness()
    const id = await parentVideo(h)
    await h.deps.store.updateVersion(id, 1, { beats: null })
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    const gets: string[] = []
    const get = h.deps.blobs.get.bind(h.deps.blobs)
    h.deps.blobs.get = async (s, k) => {
      gets.push(k)
      return get(s, k)
    }
    expect(
      (await refusal(revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } }, person('u_other')))).code,
    ).toBe('not_found')
    expect(gets).toEqual([])
  })

  it('comments keep the owner-or-admin rule; anyone who can revise can redo scenes', async () => {
    const h = harness()
    const id = await parentVideo(h)
    // Another Creator can redo scenes of this video, but can't incorporate its comments.
    const other = person('u_other')
    expect(
      (
        await refusal(
          revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] }, commentIds: ['cmt_x'] }, other),
        )
      ).code,
    ).toBe('forbidden')
    await revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } }, other)
    expect((await h.deps.store.getVersion(id, 2))?.authorId).toBe('u_other')
  })

  it('replays with the same idempotency key without a second version or attempt', async () => {
    const h = harness()
    const id = await parentVideo(h)
    const input = { fromVersion: 1, scope: { beats: ['demo'] } }
    const first = await revise(h, id, input, mia, 'idem-1')
    const again = await revise(h, id, input, mia, 'idem-1')
    expect(again.status).toBe(first.status)
    expect((await h.attempts(id)).filter((a) => a.versionN === 2)).toHaveLength(1)
    expect(await h.deps.store.getVersion(id, 3)).toBeNull()
  })

  it('an unscoped revision is unchanged', async () => {
    const h = harness({ DEBUG_LEVEL: 'debug' })
    const id = await parentVideo(h)
    await revise(h, id, {})
    const v2 = await h.deps.store.getVersion(id, 2)
    expect(v2?.scope ?? null).toBeNull()
    expect(h.deps.logs.some((l) => l.includes('video.revise_requested') && l.includes('"scope"'))).toBe(false)
  })
})
