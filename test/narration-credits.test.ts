// Provenance and credits for recorded narration (plan 2026-11-02 §6.1 Snapshots and provenance): library audio a
// version's narration plays is referenced through media_refs (owner `version`), not version_media, so usage and
// credits union those references in and take audibility from the resolved mix: the narration track not muted, a clip
// with a level. Recordings are the user's own and get no credit line.
import { describe, expect, it } from 'vitest'
import { audibleNarration, versionCredits } from '../src/domain/credits.js'
import { promoteAttemptRefs } from '../src/domain/takes.js'
import type { VersionProvenanceRow, VersionRow } from '../src/domain/types.js'
import { SAMPLE_RATE } from '../src/lib/timeline.js'
import type { Store } from '../src/store/types.js'
import { editableVideo, harness, pgStore, stubNetlify, tone, upload, type Harness } from './helpers.js'
import { narrationClip as clip } from './narration-render.js'

const S = SAMPLE_RATE

const CC_BY = {
  source: 'openverse' as const,
  sourceId: 'ov_calm_piano',
  sourceUrl: 'https://www.jamendo.com/track/1',
  sourceTitle: 'Calm Piano',
  license: 'by',
  licenseVersion: '4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  creator: 'Ada',
  creatorUrl: null,
  attribution: null,
}

const narration = (clips: object[], muted = false) => ({
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips,
  tracks: {
    narration: { volumeDb: 0, muted, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'light',
})

describe('versionCredits for narration', () => {
  const row = (mediaId: string, over: Partial<VersionProvenanceRow> = {}): VersionProvenanceRow => ({
    versionN: 2,
    mediaId,
    position: 0,
    kind: 'audio',
    narration: true,
    ...CC_BY,
    ...over,
  })
  const version = (op: unknown): Pick<VersionRow, 'n' | 'sound' | 'voiceover' | 'narration' | 'frozen'> => ({
    n: 2,
    sound: 'silent',
    voiceover: null,
    narration: op
      ? { op, recipe: { pipeline: 1, ffmpegVersion: 'x', settings: {} }, bus: null as never }
      : null,
  })

  it('credits library audio the narration plays, even on a silent version, as Narration', () => {
    const credits = versionCredits([row('med_lib')], version(narration([clip('med_lib')])))
    expect(credits.map((c) => [c.mediaId, c.role, c.licenseLabel])).toEqual([
      ['med_lib', 'Narration', 'CC BY 4.0'],
    ])
  })

  it('leaves out a muted narration track, silent clips and items the op no longer plays', () => {
    expect(versionCredits([row('med_lib')], version(narration([clip('med_lib')], true)))).toEqual([])
    expect(versionCredits([row('med_lib')], version(narration([clip('med_lib', { gainDb: null })])))).toEqual(
      [],
    )
    expect(versionCredits([row('med_lib')], version(narration([clip('med_other')])))).toEqual([])
    expect(versionCredits([row('med_lib')], version(null))).toEqual([])
  })

  it('reads the frozen op until finalize records the version narration, and tolerates a malformed one', () => {
    const frozen = { frozen: { narration: { op: narration([clip('med_lib')]) } } } as unknown as Pick<
      VersionRow,
      'frozen'
    >
    expect([...audibleNarration({ ...frozen, narration: null })]).toEqual(['med_lib'])
    expect([...audibleNarration({ narration: { op: { clips: 'nope' } } as never })]).toEqual([])
  })
})

describe('narration credits end to end', () => {
  stubNetlify()

  async function audio(h: Harness, patch: object) {
    const m = await h.json<{ id: string }>(await upload(h, h.member, tone(), 'filename=a.mp3'))
    await h.deps.store.updateMedia(m.id, { durationSec: 20, ...patch })
    return m.id
  }
  /** Saves the narration, renders it, and promotes the attempt's references to v2's as finalize does. */
  async function rendered(h: Harness, id: string, op: object) {
    const e = await h.json<{ id: string }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as: h.member }),
    )
    await h.call('POST', `/api/v1/videos/${id}/narration-lock`, { as: h.member, body: { draftId: e.id } })
    const saved = await h.call('PUT', `/api/v1/edits/${e.id}`, { as: h.member, body: { rev: 0, ops: [op] } })
    expect(saved.status).toBe(200)
    expect((await h.call('POST', `/api/v1/edits/${e.id}/render`, { as: h.member })).status).toBe(202)
    const [attempt] = (await h.attempts(id)).filter((a) => a.versionN === 2)
    await h.deps.store.tx((repo) => promoteAttemptRefs(repo, h.deps, attempt!.id, `${id}#2`))
    const video = await h.json<{ versions: { n: number; credits: { mediaId: string; role: string }[] }[] }>(
      await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }),
    )
    return video.versions.find((v) => v.n === 2)!.credits
  }

  const stores: [string, () => Promise<Store | undefined>][] = [
    ['memory', async () => undefined],
    ['postgres', pgStore],
  ]
  it.each(stores)(
    'credits library audio used as narration with its licence; own recordings get none (%s)',
    async (_name, make) => {
      const store = await make()
      const h = harness({}, store ? { store } : {})
      const id = await editableVideo(h)
      const lib = await audio(h, CC_BY)
      // Even with provenance on the row, a recording is the user's own.
      const rec = await audio(h, { ...CC_BY, sourceId: 'ov_x', role: 'narration-take', scopeJobId: id })
      const credits = await rendered(h, id, narration([clip(lib), clip(rec, { id: 'c2', start: 4 * S })]))
      expect(credits).toEqual([
        expect.objectContaining({
          mediaId: lib,
          role: 'Narration',
          license: 'by',
          licenseLabel: 'CC BY 4.0',
        }),
      ])
      expect((await h.deps.store.mediaUsage([lib, rec]))[lib]).toEqual([id])
      // v1 doesn't play it.
      const video = await h.json<{ versions: { n: number; credits: unknown[] }[] }>(
        await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }),
      )
      expect(video.versions.find((v) => v.n === 1)!.credits).toEqual([])
    },
    60_000,
  )

  it.each(stores)(
    'does not credit a muted narration track (%s)',
    async (_name, make) => {
      const store = await make()
      const h = harness({}, store ? { store } : {})
      const id = await editableVideo(h)
      const lib = await audio(h, CC_BY)
      expect(await rendered(h, id, narration([clip(lib)], true))).toEqual([])
    },
    60_000,
  )
})
