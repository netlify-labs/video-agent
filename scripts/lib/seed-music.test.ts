// npm run seed:music: which tracks it imports (CC0, 30 s to 4 min, importable, no vocals, nothing twice or already in
// the library) and how it waits for a slow Openverse. The site's API is a fake.
import { describe, expect, it } from 'vitest'
import {
  chooseSeedTracks,
  patient,
  quotas,
  seedCaption,
  seedMusic,
  summary,
  type Call,
  type Patience,
  type SeedTrack,
} from './seed-music.js'

const track = (n: number, o: Partial<SeedTrack> = {}): SeedTrack => ({
  id: `ov-${n}`,
  title: `Track ${n}`,
  creator: `Artist ${n}`,
  durationSec: 90,
  license: 'cc0',
  genres: ['electronic'],
  importable: true,
  mediaId: null,
  ...o,
})
const fresh = () => ({
  ids: new Set<string>(),
  works: new Set<string>(),
  librarySourceIds: new Set<string>(),
})
const quiet = (): Patience & { slept: number[] } => {
  const slept: number[] = []
  return {
    slept,
    sleep: async (ms) => {
      slept.push(ms)
    },
    pollMs: 1000,
    jobTimeoutMs: 10_000,
    backoffMs: [10, 20, 30],
    log: () => undefined,
  }
}
const job = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'search',
  status,
  search: null,
  media: null,
  error: null,
  expiresAt: '2030-01-01T00:00:00.000Z',
  ...extra,
})

describe('choosing tracks', () => {
  it('takes CC BY too by default, CC0 first; with cc0 only, CC BY is refused', () => {
    const items = [track(1, { license: 'by' }), track(2, { license: 'by' }), track(3)]
    expect(chooseSeedTracks(items, 2, fresh()).chosen.map((t) => t.id)).toEqual(['ov-3', 'ov-1'])
    expect(chooseSeedTracks(items, 2, fresh(), 'cc0').chosen.map((t) => t.id)).toEqual(['ov-3'])
  })

  it('keeps importable CC0 tracks of 30 s to 4 min without vocals, in order, up to the quota', () => {
    const items = [
      track(1, { license: 'by' }),
      track(2, { durationSec: 12 }),
      track(3, { durationSec: 600 }),
      track(4, { durationSec: null }),
      track(5, { importable: false }),
      track(6, { title: 'Song with vocals' }),
      track(7),
      track(8),
      track(9),
    ]
    expect(chooseSeedTracks(items, 2, fresh()).chosen.map((t) => t.id)).toEqual(['ov-7', 'ov-8'])
  })

  it('skips tracks already in the library, and the same work listed twice or found by another mood', () => {
    const seen = fresh()
    seen.librarySourceIds.add('ov-2')
    const first = chooseSeedTracks(
      [
        track(1, { mediaId: 'med_1' }),
        track(2),
        track(3),
        track(4, { title: 'TRACK 3!', creator: 'artist 3' }),
      ],
      5,
      seen,
    )
    expect(first.chosen.map((t) => t.id)).toEqual(['ov-3'])
    expect(first.inLibrary.map((t) => t.id)).toEqual(['ov-1', 'ov-2'])
    // The next mood's search returns the same track: it isn't imported twice.
    expect(chooseSeedTracks([track(3), track(5)], 5, seen).chosen.map((t) => t.id)).toEqual(['ov-5'])
  })

  it('spreads the count over the moods and captions tracks with their mood words', () => {
    expect(quotas(12).map((q) => [q.mood.mood, q.take])).toEqual([
      ['upbeat', 2],
      ['ambient', 2],
      ['corporate', 2],
      ['cinematic', 2],
      ['acoustic', 1],
      ['playful', 1],
      ['inspiring', 1],
      ['lofi', 1],
    ])
    expect(quotas(3).map((q) => q.mood.mood)).toEqual(['upbeat', 'ambient', 'corporate'])
    expect(
      seedCaption(track(1, { genres: ['Ambient', 'piano'] }), { mood: 'ambient', query: 'calm ambient' }),
    ).toBe('Track 1 by Artist 1 (ambient, calm, piano)')
  })
})

describe('waiting for Openverse', () => {
  it('retries 5xx and 429 with backoff (honouring Retry-After) and follows a 202 job to its end', async () => {
    const p = quiet()
    const answers = [
      { status: 504, json: {} },
      { status: 429, json: {}, retryAfterSec: 60 },
      { status: 202, json: job('ovj_1', 'queued') },
      { status: 200, json: job('ovj_1', 'running') },
      { status: 200, json: job('ovj_1', 'done', { search: { items: [track(1)] } }) },
    ]
    const paths: string[] = []
    const call: Call = async (_m, path) => {
      paths.push(path.split('?')[0] ?? path)
      return answers.shift() ?? { status: 500, json: {} }
    }
    const out = (await patient(call, 'GET', '/api/v1/media/openverse/search?q=x', undefined, p)) as {
      search: { items: SeedTrack[] }
    }
    expect(out.search.items.map((t) => t.id)).toEqual(['ov-1'])
    expect(p.slept).toEqual([10, 60_000, 1000, 1000])
    expect(paths.slice(-2)).toEqual([
      '/api/v1/media/openverse/jobs/ovj_1',
      '/api/v1/media/openverse/jobs/ovj_1',
    ])
  })

  it('gives up on a refusal at once, and on a failed job with its error', async () => {
    const p = quiet()
    await expect(
      patient(async () => ({ status: 400, json: { error: { message: 'Bad id.' } } }), 'POST', '/x', {}, p),
    ).rejects.toThrow('HTTP 400: Bad id.')
    const answers = [
      { status: 202, json: job('ovj_2', 'queued') },
      {
        status: 200,
        json: job('ovj_2', 'failed', { error: { code: 'upstream_error', message: 'No answer.' } }),
      },
    ]
    await expect(
      patient(async () => answers.shift() ?? { status: 500, json: {} }, 'GET', '/y', undefined, p),
    ).rejects.toThrow('No answer.')
    expect(p.slept).toEqual([1000])
  })
})

describe('seeding', () => {
  it('with --cc0-only: searches each mood, imports new CC0 tracks with mood captions, reports duplicates and failures', async () => {
    const imports: { id: string; caption: string }[] = []
    const byQuery: Record<string, SeedTrack[]> = {
      'upbeat electronic': [track(1), track(2, { license: 'by' }), track(3)],
      'calm ambient': [track(3), track(4, { mediaId: 'med_4' }), track(5)],
    }
    const call: Call = async (method, path, body) => {
      const u = new URL(path, 'https://site.example')
      if (u.pathname === '/api/v1/media')
        return {
          status: 200,
          json: {
            items: [{ source: { name: 'openverse', id: 'ov-1' } }, { source: null }],
            nextCursor: null,
          },
        }
      if (u.pathname === '/api/v1/media/openverse/search') {
        const items = byQuery[u.searchParams.get('q') ?? ''] ?? []
        expect(u.searchParams.get('license')).toBe('cc0')
        // The ambient search is slow: it becomes a job.
        if (u.searchParams.get('q') === 'calm ambient' && u.searchParams.get('page') === '1')
          return { status: 202, json: job('ovj_a', 'done', { search: { items } }) }
        return { status: 200, json: { items } }
      }
      if (method === 'POST' && u.pathname === '/api/v1/media/openverse/import') {
        const b = body as { id: string; caption: string }
        if (b.id === 'ov-5') return { status: 400, json: { error: { message: 'No usable file.' } } }
        imports.push(b)
        return { status: 201, json: { id: `med_${b.id}` } }
      }
      return { status: 404, json: {} }
    }
    const rows = await seedMusic(call, 4, quiet(), 'cc0')
    expect(imports).toEqual([{ id: 'ov-3', caption: 'Track 3 by Artist 3 (upbeat, electronic)' }])
    expect(rows.map((r) => [r.mood, r.title, r.outcome])).toEqual([
      ['upbeat', 'Track 1', 'in_library'],
      ['upbeat', 'Track 3', 'imported'],
      ['ambient', 'Track 4', 'in_library'],
      ['ambient', 'Track 5', 'failed'],
    ])
    const text = summary(rows)
    expect(text).toContain('Imported 1, already in the library 2, failed 1.')
    expect(text).toContain('"Track 3" by Artist 3, CC0, 1:30')
    expect(text).toContain('No usable file.')
  })
})
