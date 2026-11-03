// The preview bridge's mix command (src/preview/bridge.js; plan docs/plans/2026-11-02-record-your-own-voiceover.md
// §5.4), run in a vm sandbox with a fake window, document and runtime player: roles as the contract reads them,
// levels and lanes written from each element's own values, and an empty mix restoring them.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/preview/bridge.js', import.meta.url), 'utf8')

class El {
  attrs: Map<string, string>
  constructor(attrs: Record<string, string>) {
    this.attrs = new Map(Object.entries(attrs))
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v)
  }
  removeAttribute(n: string) {
    this.attrs.delete(n)
  }
}

const lane = (points: { t: number; v: number }[], other = false) =>
  JSON.stringify({
    version: 1,
    lanes: [...(other ? [{ target: 'pan', points: [{ t: 0, v: 0 }] }] : []), { target: 'volume', points }],
  })

function bridge(audio: El[]) {
  const posted: Record<string, unknown>[] = []
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) }
  const window: Record<string, unknown> = {
    __playerReady: true,
    __player: { getTime: () => 0, getDuration: () => 9, play() {}, pause() {}, seek() {} },
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ??= []).push(f),
  }
  const document = {
    addEventListener() {},
    querySelectorAll: (sel: string) => (sel === 'audio[id]' ? audio : []),
    querySelector: () => null,
    getElementById: () => null,
  }
  runInNewContext(source, {
    window,
    document,
    parent,
    location: { hash: '#ch=c1' },
    URLSearchParams,
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    innerWidth: 100,
    innerHeight: 100,
    CSS: { escape: (s: string) => s },
  })
  const send = (m: Record<string, unknown>, from: unknown = parent) => {
    for (const f of listeners.message ?? []) f({ source: from, data: { channel: 'c1', ...m } })
  }
  return { posted, send }
}

describe('bridge mix command', () => {
  const els = () => ({
    music: new El({
      id: 'music',
      'data-va-layer': 'music',
      'data-volume': '0.8',
      'data-automation': lane([{ t: 0, v: 1 }], true),
    }),
    voice: new El({ id: 'v1', 'data-va-voice': 'intro', 'data-volume': '1' }),
    sfx: new El({ id: 'whoosh', 'data-volume': '0.5' }),
    bus: new El({ id: 'va-narration', 'data-va-layer': 'narration', 'data-va-audio': 'narration' }),
    explicit: new El({ id: 'stinger', 'data-va-audio': 'music', 'data-va-layer': 'logo' }),
  })

  it('sets levels and the volume lane by role, keeping other lanes', () => {
    const e = els()
    const { posted, send } = bridge(Object.values(e))
    const points = [
      { t: 0, v: 1 },
      { t: 3.75, v: 1 },
      { t: 4, v: 0.25 },
    ]
    send({
      type: 'mix',
      tracks: {
        voice: { muted: true },
        narration: { muted: true },
        sfx: { gain: 0.5 },
        music: { lane: points },
      },
    })
    expect(posted.at(-1)).toEqual({ channel: 'c1', type: 'mix-applied', count: 5 })
    expect(e.voice.getAttribute('data-volume')).toBe('0')
    expect(e.bus.getAttribute('data-volume')).toBe('0')
    expect(e.sfx.getAttribute('data-volume')).toBe('0.25')
    expect(e.music.getAttribute('data-volume')).toBe('0.8')
    expect(JSON.parse(e.music.getAttribute('data-automation') ?? '')).toEqual(JSON.parse(lane(points, true)))
    // data-va-audio wins over the layer, as in the contract.
    expect(e.explicit.getAttribute('data-automation')).toBe(
      JSON.stringify({ version: 1, lanes: [{ target: 'volume', points }] }),
    )
  })

  it('starts every mix from the composition levels; an empty mix restores them', () => {
    const e = els()
    const { send } = bridge(Object.values(e))
    send({ type: 'mix', tracks: { sfx: { gain: 0.5 }, music: { lane: null } } })
    send({ type: 'mix', tracks: { sfx: { gain: 2 } } })
    expect(e.sfx.getAttribute('data-volume')).toBe('1') // 0.5 × 2, not 0.25 × 2
    expect(JSON.parse(e.music.getAttribute('data-automation') ?? '')).toEqual(
      JSON.parse(lane([{ t: 0, v: 1 }], true)),
    )
    send({ type: 'mix', tracks: { music: { lane: null }, voice: { gain: 9 } } })
    expect(JSON.parse(e.music.getAttribute('data-automation') ?? '').lanes).toEqual([
      { target: 'pan', points: [{ t: 0, v: 0 }] },
    ])
    expect(e.voice.getAttribute('data-volume')).toBe('4') // capped at HyperFrames' maximum
    send({ type: 'mix', tracks: {} })
    expect(e.voice.getAttribute('data-volume')).toBe('1')
    expect(e.bus.getAttribute('data-volume')).toBe('1')
    expect(e.music.getAttribute('data-automation')).toBe(lane([{ t: 0, v: 1 }], true))
    expect(e.voice.getAttribute('data-automation')).toBeNull()
  })

  it('ignores bad lanes, other channels and other senders', () => {
    const e = els()
    const { posted, send } = bridge(Object.values(e))
    const own = e.music.getAttribute('data-automation')
    for (const bad of [
      [
        { t: 2, v: 1 },
        { t: 1, v: 1 },
      ],
      [{ t: 0, v: 9 }],
      'x',
      new Array(600).fill({ t: 0, v: 1 }),
    ]) {
      send({ type: 'mix', tracks: { music: { lane: bad } } })
      expect(e.music.getAttribute('data-automation')).toBe(own)
    }
    const n = posted.length
    send({ type: 'mix', tracks: { voice: { muted: true } } }, {})
    send({ type: 'mix', channel: 'other', tracks: { voice: { muted: true } } })
    send({ type: 'mix', tracks: 'nope' })
    expect(posted).toHaveLength(n)
    expect(e.voice.getAttribute('data-volume')).toBe('1')
  })
})
