// Sound (idea 2): the audio media kind (single-request and session uploads, the /media edge route), the Sound
// choice stored on versions and plans and inherited by revisions, what the run prompt says, and the MCP arguments.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { PART_SIZE } from '../src/domain/media-uploads.js'
import { loadEdge } from './edge.js'
import type { TestDeps } from './fakes.js'
import { apiKey, harness, mcpCall, png, PROMPT, raw, stubNetlify, upload, type Harness } from './helpers.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))
const edge = async (url: string, init: RequestInit = {}) =>
  (await loadEdge('media'))(new Request(`https://video.example.com${url}`, init), {
    deploy: { published: true },
  })

const fx = (f: string) => new Uint8Array(readFileSync(new URL(`./fixtures/audio/${f}`, import.meta.url)))
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

interface Media {
  id: string
  kind: string
  status: string
  mime: string
  durationSec: number | null
  urls: { file: string } | null
}
const add = async (h: Harness, bytes: Uint8Array, q: string) =>
  h.json<Media>(await upload(h, h.member, bytes, q))
const create = async (h: Harness, body: Record<string, unknown>) =>
  h.json<{ id: string; versions: { n: number; sound: string }[] }>(
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, ...body } }),
  )
const revise = (h: Harness, id: string, body: Record<string, unknown>) =>
  h.call('POST', `/api/v1/videos/${id}/versions`, { as: h.member, body: { prompt: 'Warmer.', ...body } })
const soundOf = async (h: Harness, id: string, n: number) => (await h.deps.store.getVersion(id, n))?.sound

/** A 16-bit mono 8 kHz WAV of silence, `seconds` long: big enough to need an upload session. */
function wav(seconds: number) {
  const data = 16_000 * seconds
  const b = new Uint8Array(44 + data)
  const v = new DataView(b.buffer)
  b.set(new TextEncoder().encode('RIFF'), 0)
  v.setUint32(4, 36 + data, true)
  b.set(new TextEncoder().encode('WAVEfmt '), 8)
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true)
  v.setUint32(28, 16_000, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  b.set(new TextEncoder().encode('data'), 36)
  v.setUint32(40, data, true)
  return b
}

describe('audio media', () => {
  stubNetlify(() => {
    current = null
  })

  it('takes MP3, M4A, WAV and Ogg by their bytes, whatever the name, and lists them under audio', async () => {
    const h = harness()
    const mp3 = await add(h, fx('tone.mp3'), 'filename=theme.png&caption=Upbeat')
    expect(mp3).toMatchObject({ kind: 'audio', status: 'ready', mime: 'audio/mpeg' })
    expect(mp3.durationSec).toBeCloseTo(1.5, 1)
    expect(await add(h, fx('tone.m4a'), 'filename=a.m4a')).toMatchObject({ kind: 'audio', mime: 'audio/mp4' })
    expect(await add(h, fx('tone.wav'), 'filename=a.wav')).toMatchObject({ kind: 'audio', mime: 'audio/wav' })
    expect(await add(h, fx('tone.opus'), 'filename=a.opus')).toMatchObject({
      kind: 'audio',
      mime: 'audio/ogg',
    })
    // A clip with sound is still a video.
    expect(await add(h, fx('clip-with-audio.mp4'), 'filename=clip.mp4')).toMatchObject({ kind: 'video' })
    await add(h, png(), 'filename=logo.png')
    const list = await h.json<{ items: Media[] }>(
      await h.call('GET', '/api/v1/media?kind=audio', { as: h.member }),
    )
    expect(list.items.map((m) => m.mime).sort()).toEqual([
      'audio/mp4',
      'audio/mpeg',
      'audio/ogg',
      'audio/wav',
    ])
  })

  it('the edge serves audio with its own type and Range', async () => {
    const h = harness()
    current = h.deps
    const bytes = fx('tone.mp3')
    const m = await add(h, bytes, 'filename=theme.mp3')
    const whole = await edge(m.urls?.file ?? '')
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('audio/mpeg')
    expect(whole.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await whole.arrayBuffer()).byteLength).toBe(bytes.byteLength)
    const part = await edge(m.urls?.file ?? '', { headers: { range: 'bytes=100-199' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-type')).toBe('audio/mpeg')
    expect(part.headers.get('content-range')).toBe(`bytes 100-199/${bytes.byteLength}`)
    expect((await part.arrayBuffer()).byteLength).toBe(100)
    const m4a = await add(h, fx('tone.m4a'), 'filename=a.m4a')
    expect((await edge(m4a.urls?.file ?? '')).headers.get('content-type')).toBe('audio/mp4')
  })

  it('files over 4 MB go through an upload session and come out as audio with their length', async () => {
    const h = harness()
    const file = wav(400)
    expect((await upload(h, h.member, file, 'filename=long.wav')).status).toBe(400)
    const s = await h.json<{ id: string; partCount: number }>(
      await h.call('POST', '/api/v1/media/uploads', {
        as: h.member,
        body: { filename: 'long.wav', size: file.byteLength, sha256: sha(file) },
      }),
    )
    expect(s.partCount).toBe(2)
    for (let i = 0; i < s.partCount; i++) {
      const body = file.subarray(i * PART_SIZE, Math.min(file.byteLength, (i + 1) * PART_SIZE))
      const res = await raw(h, h.member, 'PUT', `/api/v1/media/uploads/${s.id}/parts/${i}`, body, {
        'x-part-sha256': sha(body),
      })
      expect(res.status).toBe(200)
    }
    const done = await h.json<{ status: string; mediaId: string }>(
      await h.call('POST', `/api/v1/media/uploads/${s.id}/complete`, { as: h.member, body: {} }),
    )
    expect(done.status).toBe('done')
    const m = await h.json<Media>(await h.call('GET', `/api/v1/media/${done.mediaId}`, { as: h.member }))
    expect(m).toMatchObject({ kind: 'audio', status: 'ready', mime: 'audio/wav', durationSec: 400 })
  })

  it('a session rejects audio over 10 minutes with the reason', async () => {
    const h = harness()
    const file = wav(660)
    const s = await h.json<{ id: string; partCount: number }>(
      await h.call('POST', '/api/v1/media/uploads', {
        as: h.member,
        body: { filename: 'long.wav', size: file.byteLength, sha256: sha(file) },
      }),
    )
    for (let i = 0; i < s.partCount; i++) {
      const body = file.subarray(i * PART_SIZE, Math.min(file.byteLength, (i + 1) * PART_SIZE))
      await raw(h, h.member, 'PUT', `/api/v1/media/uploads/${s.id}/parts/${i}`, body)
    }
    const done = await h.json<{ status: string; error: string }>(
      await h.call('POST', `/api/v1/media/uploads/${s.id}/complete`, { as: h.member, body: {} }),
    )
    expect(done).toMatchObject({ status: 'failed', error: 'Audio files must be 10 minutes or shorter.' })
  })
})

describe('sound per version', () => {
  it('defaults to silent, keeps the silent prompt, and shows on the version', async () => {
    const h = harness()
    const v = await create(h, {})
    expect(v.versions[0]?.sound).toBe('silent')
    await h.drive(1)
    expect(h.deps.runner.starts[0]?.prompt).toContain('30 fps, silent.')
  })

  it('an audio pick turns music on, names the track in the prompt, and the run manifest hydrates it', async () => {
    const h = harness()
    const track = await add(h, fx('tone.mp3'), 'filename=theme.mp3&caption=Upbeat%20bed')
    const v = await create(h, { mediaIds: [track.id] })
    expect(await soundOf(h, v.id, 1)).toBe('music')
    await h.drive(1)
    const prompt = h.deps.runner.starts[0]?.prompt ?? ''
    expect(prompt).toContain('with sound (music)')
    expect(prompt).toMatch(
      new RegExp(
        `\\[\\{"file":"assets/media/${track.id}\\.mp3","caption":"Upbeat bed","seconds":1\\.5\\d*\\}\\]`,
      ),
    )
    expect(prompt).toContain('--manifest ')
  })

  it('an explicit choice wins: silent with a track never mentions it; music_sfx asks for effects', async () => {
    const h = harness()
    const track = await add(h, fx('tone.mp3'), 'filename=theme.mp3')
    const quiet = await create(h, { mediaIds: [track.id], sound: 'silent' })
    expect(await soundOf(h, quiet.id, 1)).toBe('silent')
    const loud = await create(h, { sound: 'music_sfx' })
    expect(await soundOf(h, loud.id, 1)).toBe('music_sfx')
    await h.drive(1)
    const prompts = h.deps.runner.starts.map((s) => s.prompt)
    const quietPrompt = prompts.find((p) => p.includes(quiet.id)) ?? ''
    expect(quietPrompt).toContain('30 fps, silent.')
    expect(quietPrompt).not.toContain(track.id)
    expect(prompts.find((p) => p.includes(loud.id))).toContain('Sound effects')
    expect(
      (await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, sound: 'loud' } }))
        .status,
    ).toBe(400)
  })

  it('revisions inherit the sound unless changed; a new track turns music on for a silent video', async () => {
    const h = harness()
    const v = await create(h, { sound: 'music' })
    await h.drive(4)
    expect((await revise(h, v.id, {})).status).toBe(202)
    expect(await soundOf(h, v.id, 2)).toBe('music')
    await h.drive(4)
    expect((await revise(h, v.id, { sound: 'silent' })).status).toBe(202)
    expect(await soundOf(h, v.id, 3)).toBe('silent')
    await h.drive(4)
    const track = await add(h, fx('tone.m4a'), 'filename=a.m4a')
    expect((await revise(h, v.id, { mediaIds: [track.id] })).status).toBe(202)
    expect(await soundOf(h, v.id, 4)).toBe('music')
    await h.drive(4)
    // The track is inherited now, so it doesn't turn music back on by itself.
    await revise(h, v.id, { sound: 'silent' })
    await h.drive(4)
    await revise(h, v.id, {})
    expect(await soundOf(h, v.id, 6)).toBe('silent')
    const got = await h.json<{ versions: { n: number; sound: string }[] }>(
      await h.call('GET', `/api/v1/videos/${v.id}`, { as: h.member }),
    )
    expect(got.versions.map((x) => [x.n, x.sound])).toEqual([
      [6, 'silent'],
      [5, 'silent'],
      [4, 'music'],
      [3, 'silent'],
      [2, 'music'],
      [1, 'music'],
    ])
  })

  it('plans carry the sound to the planner and to the video made from them', async () => {
    const h = harness()
    const created = await h.call('POST', '/api/v1/plans', {
      as: h.member,
      body: { prompt: PROMPT, sound: 'music_sfx' },
    })
    const plan = await h.json<{ id: string; sound: string | null }>(created)
    expect(plan.sound).toBe('music_sfx')
    h.deps.gateway.replies.push(JSON.stringify({ questions: [] }))
    await h.call('POST', `/api/v1/plans/${plan.id}/questions`, { as: h.member })
    expect(h.deps.gateway.calls.find((c) => c.kind === 'messages')?.user).toContain(
      '<data name="chosen_sound">',
    )
    h.deps.gateway.replies.push(
      JSON.stringify({
        goal: 'g',
        audience: 'a',
        keyMessage: 'k',
        beats: [{ text: 'Hi', seconds: 6 }],
        tone: 't',
        callToAction: 'c',
        mustInclude: [],
        avoid: [],
      }),
    )
    await h.call('POST', `/api/v1/plans/${plan.id}/brief`, { as: h.member, body: { answers: [] } })
    const v = await create(h, { planId: plan.id })
    expect(await soundOf(h, v.id, 1)).toBe('music_sfx')
    const plain = await h.json<{ sound: string | null }>(
      await h.call('POST', '/api/v1/plans', { as: h.member, body: { prompt: PROMPT } }),
    )
    expect(plain.sound).toBeNull()
  })

  it('MCP create_video, revise_video and plan_video take sound', async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const call = (name: string, args: Record<string, unknown>) =>
      mcpCall(h, key, 'tools/call', { name, arguments: args }) as Promise<{
        structuredContent: Record<string, unknown>
        isError?: boolean
      }>
    const tools = (await mcpCall(h, key, 'tools/list', {})) as {
      tools: { name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }[]
    }
    for (const name of ['create_video', 'revise_video', 'plan_video'])
      expect(tools.tools.find((t) => t.name === name)?.inputSchema.properties.sound?.enum).toEqual([
        'silent',
        'music',
        'music_sfx',
      ])
    const created = await call('create_video', { prompt: PROMPT, sound: 'music' })
    const id = created.structuredContent.video_id as string
    expect(await soundOf(h, id, 1)).toBe('music')
    await h.drive(4)
    await call('revise_video', { video_id: id, change: 'Calmer.', sound: 'music_sfx' })
    expect(await soundOf(h, id, 2)).toBe('music_sfx')
    const got = await call('get_video', { video_id: id })
    expect((got.structuredContent.versions as { sound?: string }[])[0]?.sound).toBe('music_sfx')
  })
})
