// Clip editing commands and undo/redo (narration-commands.ts). Property tests use a small seeded generator (no
// fast-check dependency), as src/lib/timeline.test.ts does.
import { describe, expect, it } from 'vitest'
import {
  clipEnd,
  clipLength,
  compositionTime,
  GAIN_DB_RANGE,
  IDENTITY_FIT,
  MAX_NARRATION_CLIPS,
  maxFade,
  outputEnd,
  outputLimit,
  SAMPLE_RATE,
  segments,
  XFADE_SAMPLES,
  type NarrationClip,
  type NarrationOp,
} from '../../../src/lib/timeline'
import {
  applyCommand,
  editorReducer,
  initHistory,
  isEditableTarget,
  keyAction,
  MAX_UNDO,
  minClipSamples,
  sameClips,
  type EditContext,
  type EditorHistory,
  type NarrationCommand,
} from './narration-commands'

const FPS = 30
const FRAME = SAMPLE_RATE / FPS
const TAKE = 60 * SAMPLE_RATE

const clip = (o: Partial<NarrationClip> & { id: string }): NarrationClip => ({
  mediaId: 'm1',
  srcStart: 0,
  srcEnd: SAMPLE_RATE,
  fit: IDENTITY_FIT,
  offsetSamples: 0,
  start: 0,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...o,
})

const opOf = (clips: NarrationClip[]): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: SAMPLE_RATE,
  clips,
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'off',
})

const ctx: EditContext = {
  takeSamples: new Map([
    ['m1', TAKE],
    ['m2', TAKE],
    ['m3', TAKE],
  ]),
  baseSamples: 30 * SAMPLE_RATE,
  fps: FPS,
}

const ok = (op: NarrationOp, cmd: NarrationCommand) => {
  const r = applyCommand(op, cmd, ctx)
  if (!r.ok) throw new Error(`rejected: ${r.reason}`)
  return r
}

describe('applyCommand', () => {
  const two = opOf([
    clip({ id: 'a', start: 0, srcStart: 0, srcEnd: SAMPLE_RATE }),
    clip({ id: 'b', mediaId: 'm2', start: 2 * SAMPLE_RATE, srcStart: 0, srcEnd: SAMPLE_RATE }),
  ])

  it('moves a clip, clamping at 0, and announces where it went', () => {
    const r = ok(two, { type: 'move', clipId: 'a', start: 12.4 * SAMPLE_RATE })
    expect(r.op.clips.map((c) => [c.id, c.start])).toEqual([
      ['b', 2 * SAMPLE_RATE],
      ['a', 12.4 * SAMPLE_RATE],
    ])
    expect(r.message).toBe('Clip moved to 0:12.40')
    // b lands on a at 0 and, being moved, wins: a is wholly under it and goes.
    expect(ok(two, { type: 'move', clipId: 'b', start: -500 }).op.clips.map((c) => [c.id, c.start])).toEqual([
      ['b', 0],
    ])
  })

  it('a moved clip wins where it lands, trimming the one under it non-destructively', () => {
    const r = ok(two, { type: 'move', clipId: 'b', start: SAMPLE_RATE / 2 })
    const a = r.op.clips.find((c) => c.id === 'a')
    expect(a).toMatchObject({ start: 0, srcStart: 0, srcEnd: SAMPLE_RATE / 2 })
  })

  it('moves with a new source start in one step (Align to AI voice trimming a lead-in)', () => {
    const r = ok(two, { type: 'move', clipId: 'b', start: 5 * SAMPLE_RATE, srcStart: SAMPLE_RATE / 4 })
    expect(r.op.clips.find((c) => c.id === 'b')).toMatchObject({
      start: 5 * SAMPLE_RATE,
      srcStart: SAMPLE_RATE / 4,
      srcEnd: SAMPLE_RATE,
    })
    // Never past the clip's last frame.
    const far = ok(two, { type: 'move', clipId: 'b', start: 0, srcStart: 10 * SAMPLE_RATE })
    expect(far.op.clips.find((c) => c.id === 'b')?.srcStart).toBe(SAMPLE_RATE - minClipSamples(FPS))
    expect(applyCommand(two, { type: 'move', clipId: 'b', start: 0, srcStart: NaN }, ctx).ok).toBe(false)
  })

  it('nudges by whole frames', () => {
    expect(ok(two, { type: 'nudge', clipId: 'b', frames: 1 }).op.clips[1]?.start).toBe(
      2 * SAMPLE_RATE + FRAME,
    )
    expect(ok(two, { type: 'nudge', clipId: 'b', frames: -10 }).op.clips[1]?.start).toBe(
      2 * SAMPLE_RATE - 10 * FRAME,
    )
  })

  it('trims the start by moving srcStart with it, clamped to the take and a one-frame minimum', () => {
    const op = opOf([
      clip({ id: 'a', start: SAMPLE_RATE, srcStart: SAMPLE_RATE / 2, srcEnd: 2 * SAMPLE_RATE }),
    ])
    const r = ok(op, { type: 'trimStart', clipId: 'a', at: SAMPLE_RATE + 1000 })
    expect(r.op.clips[0]).toMatchObject({ start: SAMPLE_RATE + 1000, srcStart: SAMPLE_RATE / 2 + 1000 })
    // Out past the take's first sample: stops at source 0.
    expect(ok(op, { type: 'trimStart', clipId: 'a', at: 0 }).op.clips[0]).toMatchObject({
      start: SAMPLE_RATE / 2,
      srcStart: 0,
    })
    // Past the end: one frame stays.
    const short = ok(op, { type: 'trimStart', clipId: 'a', at: 10 * SAMPLE_RATE }).op.clips[0]
    expect(short && clipLength(short)).toBe(minClipSamples(FPS))
  })

  it('trims the end within the take', () => {
    const op = opOf([clip({ id: 'a', start: 0, srcStart: 0, srcEnd: SAMPLE_RATE })])
    expect(ok(op, { type: 'trimEnd', clipId: 'a', at: 100 * SAMPLE_RATE }).op.clips[0]?.srcEnd).toBe(
      Math.min(TAKE, outputLimit(ctx.baseSamples)),
    )
    expect(ok(op, { type: 'trimEnd', clipId: 'a', at: -5 }).op.clips[0]?.srcEnd).toBe(FRAME)
    // A take of unknown length can't grow.
    const unknown = opOf([clip({ id: 'a', mediaId: 'mx', srcEnd: SAMPLE_RATE })])
    expect(ok(unknown, { type: 'trimEnd', clipId: 'a', at: 5 * SAMPLE_RATE }).op.clips[0]?.srcEnd).toBe(
      SAMPLE_RATE,
    )
  })

  it('splits inside a clip, giving the right piece a fresh id and dropping the inner fades', () => {
    const op = opOf([
      clip({ id: 'a', start: 1000, srcEnd: SAMPLE_RATE, fadeInSamples: 100, fadeOutSamples: 200 }),
    ])
    const r = ok(op, { type: 'split', clipId: 'a', at: 5000 })
    expect(r.message).toBe('Split')
    expect(r.op.clips).toMatchObject([
      { id: 'a', start: 1000, srcStart: 0, srcEnd: 4000, fadeInSamples: 100, fadeOutSamples: 0 },
      { id: 'a~2', start: 5000, srcStart: 4000, srcEnd: SAMPLE_RATE, fadeInSamples: 0, fadeOutSamples: 200 },
    ])
    expect(ok(r.op, { type: 'split', clipId: 'a~2', at: 6000 }).op.clips.map((c) => c.id)).toEqual([
      'a',
      'a~2',
      'a~3',
    ])
    for (const at of [1000, 1000 + SAMPLE_RATE, 0]) {
      const bad = applyCommand(op, { type: 'split', clipId: 'a', at }, ctx)
      expect(bad).toEqual({ ok: false, reason: "The playhead isn't inside the clip" })
    }
  })

  it('deletes, sets gain (clamped; -Infinity is silent) and fades (clamped to the clip)', () => {
    expect(ok(two, { type: 'delete', clipId: 'a' }).op.clips.map((c) => c.id)).toEqual(['b'])
    expect(ok(two, { type: 'setGain', clipId: 'a', gainDb: 40 }).op.clips[0]?.gainDb).toBe(GAIN_DB_RANGE[1])
    expect(ok(two, { type: 'setGain', clipId: 'a', gainDb: -Infinity }).op.clips[0]?.gainDb).toBeNull()
    expect(ok(two, { type: 'setGain', clipId: 'a', gainDb: -6 }).message).toBe('Gain -6 dB')
    expect(applyCommand(two, { type: 'setGain', clipId: 'a', gainDb: NaN }, ctx).ok).toBe(false)
    const f = ok(two, { type: 'setFades', clipId: 'a', fadeInSamples: 10 * SAMPLE_RATE }).op.clips[0]
    expect(f).toMatchObject({ fadeInSamples: SAMPLE_RATE / 2, fadeOutSamples: 0 })
  })

  it('rejects what breaks a limit, with a reason, and an unknown clip', () => {
    const past = applyCommand(two, { type: 'move', clipId: 'b', start: outputLimit(ctx.baseSamples) }, ctx)
    expect(past.ok).toBe(false)
    if (!past.ok) expect(past.reason).toMatch(/can't run past/)
    expect(applyCommand(two, { type: 'delete', clipId: 'zz' }, ctx)).toEqual({
      ok: false,
      reason: 'That clip is gone',
    })
    const full = opOf(
      Array.from({ length: MAX_NARRATION_CLIPS }, (_, i) =>
        clip({ id: `c${i}`, start: i * 1000, srcStart: 0, srcEnd: 1000 }),
      ),
    )
    const r = applyCommand(full, { type: 'split', clipId: 'c0', at: 500 }, ctx)
    expect(r).toEqual({ ok: false, reason: `A narration can have at most ${MAX_NARRATION_CLIPS} clips` })
  })
})

describe('editorReducer', () => {
  const base = opOf([clip({ id: 'a', start: 0 }), clip({ id: 'b', start: 2 * SAMPLE_RATE })])
  const command = (h: EditorHistory, cmd: NarrationCommand, coalesce?: string) =>
    editorReducer(h, { type: 'command', command: cmd, ctx, ...(coalesce ? { coalesce } : {}) })

  it('undoes and redoes; a new command clears redo', () => {
    let h = initHistory(base)
    h = command(h, { type: 'delete', clipId: 'a' })
    h = command(h, { type: 'nudge', clipId: 'b', frames: 1 })
    expect(h.past).toHaveLength(2)
    h = editorReducer(h, { type: 'undo' })
    expect(h.present.clips[0]?.start).toBe(2 * SAMPLE_RATE)
    expect(h.last?.message).toBe('Undone')
    h = editorReducer(h, { type: 'undo' })
    expect(sameClips(h.present, initHistory(base).present)).toBe(true)
    expect(editorReducer(h, { type: 'undo' }).last).toMatchObject({ ok: false, message: 'Nothing to undo' })
    h = editorReducer(h, { type: 'redo' })
    expect(h.present.clips.map((c) => c.id)).toEqual(['b'])
    h = command(h, { type: 'setGain', clipId: 'b', gainDb: -3 })
    expect(h.future).toHaveLength(0)
  })

  it('a rejected command or a no-op changes nothing and pushes nothing', () => {
    const h = initHistory(base)
    const r = command(h, { type: 'split', clipId: 'a', at: 0 })
    expect(r.present).toBe(h.present)
    expect(r.past).toHaveLength(0)
    expect(r.last).toMatchObject({ ok: false })
    const same = command(h, { type: 'move', clipId: 'a', start: 0 })
    expect(same.past).toHaveLength(0)
    expect(same.last?.message).toBe('No change')
  })

  it('coalesces a drag into one undo entry, each step applied to the op before the drag', () => {
    let h = initHistory(base)
    // Dragging b across a and on: a is trimmed while b is over it, then whole again.
    for (const s of [SAMPLE_RATE / 2, 3000, 5 * SAMPLE_RATE])
      h = command(h, { type: 'move', clipId: 'b', start: s }, 'drag:1')
    expect(h.past).toHaveLength(1)
    expect(h.present.clips.find((c) => c.id === 'a')).toMatchObject({ srcStart: 0, srcEnd: SAMPLE_RATE })
    h = editorReducer(h, { type: 'commit' })
    h = command(h, { type: 'move', clipId: 'b', start: 6 * SAMPLE_RATE }, 'drag:2')
    expect(h.past).toHaveLength(2)
    // A drag back to where it began leaves no entry.
    h = command(h, { type: 'move', clipId: 'b', start: 5 * SAMPLE_RATE }, 'drag:2')
    expect(h.past).toHaveLength(1)
    h = editorReducer(h, { type: 'undo' })
    expect(sameClips(h.present, initHistory(base).present)).toBe(true)
  })

  it('keeps at most MAX_UNDO entries', () => {
    let h = initHistory(base)
    for (let i = 0; i < MAX_UNDO + 20; i++) h = command(h, { type: 'nudge', clipId: 'b', frames: 1 })
    expect(h.past).toHaveLength(MAX_UNDO)
  })
})

describe('keys', () => {
  const k = (
    key: string,
    o: Partial<Record<'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey', boolean>> = {},
  ) => ({
    key,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...o,
  })
  it('maps Mac and non-Mac shortcuts', () => {
    expect(keyAction(k('z', { metaKey: true }), true)).toEqual({ type: 'undo' })
    expect(keyAction(k('Z', { metaKey: true, shiftKey: true }), true)).toEqual({ type: 'redo' })
    expect(keyAction(k('z', { ctrlKey: true }), true)).toBeNull()
    expect(keyAction(k('z', { ctrlKey: true }), false)).toEqual({ type: 'undo' })
    expect(keyAction(k('z', { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: 'redo' })
    expect(keyAction(k('y', { ctrlKey: true }), false)).toEqual({ type: 'redo' })
    expect(keyAction(k('y', { metaKey: true }), true)).toBeNull()
    expect(keyAction(k('s'), true)).toEqual({ type: 'split' })
    expect(keyAction(k('s', { metaKey: true }), true)).toBeNull()
    expect(keyAction(k('Backspace'), false)).toEqual({ type: 'delete' })
    expect(keyAction(k('Delete'), false)).toEqual({ type: 'delete' })
    expect(keyAction(k('ArrowLeft'), false)).toEqual({ type: 'nudge', frames: -1 })
    expect(keyAction(k('ArrowRight', { shiftKey: true }), false)).toEqual({ type: 'nudge', frames: 10 })
    expect(keyAction(k('ArrowRight', { altKey: true }), false)).toBeNull()
    expect(keyAction(k('F10', { shiftKey: true }), false)).toEqual({ type: 'menu' })
    expect(keyAction(k('ContextMenu'), false)).toEqual({ type: 'menu' })
  })
  it('knows text fields', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

// ---- properties

/** mulberry32: a tiny deterministic PRNG for the property tests. */
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) }
}

const small: EditContext = {
  takeSamples: new Map([
    ['m1', 40_000],
    ['m2', 30_000],
    ['m3', 50_000],
  ]),
  baseSamples: 60_000,
  fps: FPS,
}

function randomOp(r: ReturnType<typeof rng>): NarrationOp {
  return opOf(
    Array.from({ length: r.int(1, 8) }, (_, i) => {
      const srcStart = r.int(0, 20_000)
      return clip({
        id: `c${i}`,
        mediaId: `m${r.int(1, 3)}`,
        srcStart,
        srcEnd: srcStart + r.int(1_000, 10_000),
        start: r.int(0, 40_000),
        fadeInSamples: r.int(0, 300),
        fadeOutSamples: r.int(0, 300),
      })
    }),
  )
}

function randomCommand(r: ReturnType<typeof rng>, op: NarrationOp): NarrationCommand {
  const c = op.clips[r.int(0, Math.max(0, op.clips.length - 1))]
  const clipId = r.next() < 0.05 ? 'gone' : (c?.id ?? 'gone')
  const at = c ? r.int(c.start - 2_000, clipEnd(c) + 2_000) : 0
  switch (r.int(0, 7)) {
    case 0:
      return { type: 'move', clipId, start: r.int(-5_000, 80_000) }
    case 1:
      return { type: 'trimStart', clipId, at }
    case 2:
      return { type: 'trimEnd', clipId, at: r.int(-1_000, 90_000) }
    case 3:
      return { type: 'split', clipId, at }
    case 4:
      return { type: 'delete', clipId }
    case 5:
      return { type: 'setGain', clipId, gainDb: r.next() < 0.1 ? null : r.int(-90, 30) }
    case 6:
      return { type: 'setFades', clipId, fadeInSamples: r.int(-10, 5_000), fadeOutSamples: r.int(-10, 5_000) }
    default:
      return { type: 'nudge', clipId, frames: r.int(-12, 12) }
  }
}

function expectInvariants(op: NarrationOp, ctx2: EditContext) {
  const cs = op.clips
  expect(cs.length).toBeLessThanOrEqual(MAX_NARRATION_CLIPS)
  expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length)
  expect(outputEnd(cs)).toBeLessThanOrEqual(outputLimit(ctx2.baseSamples))
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]
    if (!c) continue
    expect(clipLength(c)).toBeGreaterThan(0)
    expect(c.start).toBeGreaterThanOrEqual(0)
    expect(c.srcStart).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(c.start) && Number.isInteger(c.srcStart) && Number.isInteger(c.srcEnd)).toBe(true)
    expect(Math.max(c.fadeInSamples, c.fadeOutSamples)).toBeLessThanOrEqual(maxFade(clipLength(c)))
    if (c.gainDb !== null) {
      expect(c.gainDb).toBeGreaterThanOrEqual(GAIN_DB_RANGE[0])
      expect(c.gainDb).toBeLessThanOrEqual(GAIN_DB_RANGE[1])
    }
    // Sorted and non-overlapping.
    const next = cs[i + 1]
    if (next) expect(clipEnd(c)).toBeLessThanOrEqual(next.start)
  }
}

describe('properties', () => {
  it('any command sequence keeps the resolve invariants and limits; rejections change nothing', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      let h = initHistory(randomOp(r))
      for (let step = 0; step < 40; step++) {
        const cmd = randomCommand(r, h.present)
        const next = editorReducer(h, { type: 'command', command: cmd, ctx: small })
        if (!next.last?.ok) expect(next.present).toBe(h.present)
        // Ops from the generator may start past the limit; the commands only make sure they don't grow past it.
        if (next.present !== h.present) expectInvariants(next.present, { ...small, baseSamples: 1e9 })
        h = next
      }
    }
  })

  it('accepted commands keep a within-limit op within the limit', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 13)
      let h = initHistory(
        opOf([clip({ id: 'a', srcEnd: 5_000 }), clip({ id: 'b', start: 8_000, srcEnd: 5_000 })]),
      )
      for (let step = 0; step < 40; step++) {
        h = editorReducer(h, { type: 'command', command: randomCommand(r, h.present), ctx: small })
        expectInvariants(h.present, small)
      }
    }
  })

  it('undo(redo(x)) == x and redo(undo(x)) == x, along any history', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 31)
      let h = initHistory(randomOp(r))
      for (let step = 0; step < 30; step++) {
        const roll = r.next()
        h =
          roll < 0.2
            ? editorReducer(h, { type: 'undo' })
            : roll < 0.3
              ? editorReducer(h, { type: 'redo' })
              : editorReducer(h, { type: 'command', command: randomCommand(r, h.present), ctx: small })
        if (h.past.length) {
          const back = editorReducer(editorReducer(h, { type: 'undo' }), { type: 'redo' })
          expect(back.present).toBe(h.present)
          expect(back.past).toEqual(h.past)
        }
        if (h.future.length) {
          const back = editorReducer(editorReducer(h, { type: 'redo' }), { type: 'undo' })
          expect(back.present).toBe(h.present)
          expect(back.future).toEqual(h.future)
        }
      }
    }
  })

  it('split keeps every source sample at its composition time', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 101)
      const op = initHistory(randomOp(r)).present
      const c = op.clips[r.int(0, op.clips.length - 1)]
      if (!c || clipLength(c) < 2) continue
      const at = r.int(c.start + 1, clipEnd(c) - 1)
      const res = applyCommand(op, { type: 'split', clipId: c.id, at }, { ...small, baseSamples: 1e9 })
      if (!res.ok) throw new Error(res.reason)
      const pieces = res.op.clips.filter(
        (p) => p.mediaId === c.mediaId && p.id.replace(/~\d+$/, '') === c.id.replace(/~\d+$/, ''),
      )
      for (let s = c.srcStart; s < c.srcEnd; s += Math.max(1, Math.floor(clipLength(c) / 50))) {
        const p = pieces.find((x) => s >= x.srcStart && s < x.srcEnd)
        expect(p && compositionTime(p, s)).toBe(compositionTime(c, s))
      }
      // The other clips don't move.
      for (const o of op.clips) if (o.id !== c.id) expect(res.op.clips).toContainEqual(o)
      expect(res.op.clips).toHaveLength(op.clips.length + 1)
    }
  })
})

describe('insert (a new take on the track)', () => {
  it('lays the clip on top: it wins where it overlaps, the clip under it is trimmed', () => {
    const op = opOf([clip({ id: 'a', srcEnd: 4 * SAMPLE_RATE })])
    const res = applyCommand(
      op,
      {
        type: 'insert',
        clip: clip({ id: 'b', mediaId: 'm2', start: 3 * SAMPLE_RATE, srcEnd: 2 * SAMPLE_RATE }),
      },
      ctx,
    )
    if (!res.ok) throw new Error(res.reason)
    expect(res.op.clips.map((c) => [c.id, c.start, clipEnd(c)])).toEqual([
      ['a', 0, 3 * SAMPLE_RATE],
      ['b', 3 * SAMPLE_RATE, 5 * SAMPLE_RATE],
    ])
    expect(res.message).toBe('Clip added at 0:03.00')
  })

  it('refuses a reused id, an empty clip, and one past the output limit', () => {
    const op = opOf([clip({ id: 'a' })])
    expect(
      applyCommand(op, { type: 'insert', clip: clip({ id: 'a', start: 5 * SAMPLE_RATE }) }, ctx).ok,
    ).toBe(false)
    expect(applyCommand(op, { type: 'insert', clip: clip({ id: 'b', srcEnd: 0 }) }, ctx).ok).toBe(false)
    const far = clip({ id: 'c', start: outputLimit(ctx.baseSamples) - SAMPLE_RATE / 2 })
    expect(applyCommand(op, { type: 'insert', clip: far }, ctx)).toEqual({
      ok: false,
      reason: "The narration can't run past 2:30",
    })
  })

  it('is one undo entry', () => {
    let h = initHistory(opOf([]))
    h = editorReducer(h, { type: 'command', command: { type: 'insert', clip: clip({ id: 'n' }) }, ctx })
    expect(h.present.clips).toHaveLength(1)
    h = editorReducer(h, { type: 'undo' })
    expect(h.present.clips).toHaveLength(0)
  })

  it("adds a recorded take's pieces together, as one undo entry, and refuses a repeated id among them", () => {
    let h = initHistory(opOf([]))
    const first = clip({ id: 'n1', srcStart: 0, srcEnd: SAMPLE_RATE, start: 0 })
    const second = clip({
      id: 'n2',
      srcStart: SAMPLE_RATE,
      srcEnd: 2 * SAMPLE_RATE,
      start: SAMPLE_RATE + 800,
    })
    h = editorReducer(h, { type: 'command', command: { type: 'insert', clip: first, with: [second] }, ctx })
    expect(h.present.clips.map((c) => c.id)).toEqual(['n1', 'n2'])
    h = editorReducer(h, { type: 'undo' })
    expect(h.present.clips).toHaveLength(0)
    expect(applyCommand(opOf([]), { type: 'insert', clip: first, with: [first] }, ctx).ok).toBe(false)
  })

  it('a punch-in over the middle of a clip replaces exactly its range: the older clip is split around it, its samples keep their times, joins crossfade on handle audio, and it is one undo entry', () => {
    const S = SAMPLE_RATE
    // A 6 s take at 0; the punch take (m2) recorded from a 2 s pre-roll and re-records 2-4 s.
    const op = opOf([clip({ id: 'a', srcEnd: 6 * S })])
    const punch = clip({ id: 'p', mediaId: 'm2', start: 2 * S, srcStart: 2 * S + 77, srcEnd: 4 * S + 77 })
    let h = initHistory(op)
    h = editorReducer(h, { type: 'command', command: { type: 'insert', clip: punch }, ctx })
    expect(h.present.clips.map((c) => [c.id, c.mediaId, c.start, clipEnd(c), c.srcStart])).toEqual([
      ['a', 'm1', 0, 2 * S, 0],
      ['p', 'm2', 2 * S, 4 * S, 2 * S + 77],
      ['a~2', 'm1', 4 * S, 6 * S, 4 * S],
    ])
    // Both edit points have handle audio on both sides: 20 ms equal-power crossfades.
    const segs = segments(h.present.clips, ctx.takeSamples)
    expect(segs.map((g) => [g.head.kind, g.tail.kind])).toEqual([
      ['none', 'xfade'],
      ['xfade', 'xfade'],
      ['xfade', 'none'],
    ])
    expect(segs[1]).toMatchObject({ from: 2 * S - XFADE_SAMPLES / 2, to: 4 * S + XFADE_SAMPLES / 2 })
    h = editorReducer(h, { type: 'undo' })
    expect(sameClips(h.present, initHistory(op).present)).toBe(true)
  })
})
