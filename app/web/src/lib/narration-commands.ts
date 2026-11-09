// Clip editing commands and the local undo/redo stack for the narration timeline
// (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3, §5.5). Draft saves keep only the newest revision
// (edits.ts:208), so undo lives here, in the browser. Pure: every command maps an op to a new op through
// app/server/lib/timeline.ts, re-resolves the clips and checks the op's limits; a command that would break one is rejected
// with a reason and changes nothing. The hook (use-narration-editor.ts) wires the timeline's pointer and key events
// to these commands. A punch-in's insert keeps what it covers as the new clip's take alternatives, and swapTake puts
// another take of a slot in place, each where it was recorded (§9 phase 6).
import {
  altStart,
  clipEnd,
  clipLength,
  cutAlternative,
  cutSlot,
  frameStart,
  GAIN_DB_RANGE,
  MAX_NARRATION_CLIPS,
  MAX_NARRATION_TAKES,
  maxFade,
  nudge,
  opTakeIds,
  outputEnd,
  outputLimit,
  resolve,
  SAMPLE_RATE,
  slotTakes,
  withAlternatives,
  withoutAlternatives,
  type NarrationClip,
  type NarrationOp,
  type TakeAlternative,
} from '../../../server/lib/timeline'
import { formatTime } from './timeline-view'

/** What the commands need to know beyond the op. */
export interface EditContext {
  /** Each take's length in source samples; a trim never reaches past it (unknown takes can't grow). */
  takeSamples: ReadonlyMap<string, number>
  /** The base video's length in samples, for the output limit. */
  baseSamples: number
  /** The composition's frame rate, for nudges and the shortest clip (one frame). */
  fps: number
}

export type NarrationCommand =
  /**
   * Put the clip's start at composition sample `start` (clamped at 0). The moved clip wins where it overlaps. With
   * `srcStart`, the clip also starts at that source sample (its end stays): Align to AI voice trims a take's lead-in.
   */
  | { type: 'move'; clipId: string; start: number; srcStart?: number }
  /** Move the clip's left edge to composition sample `at`, moving srcStart with it. */
  | { type: 'trimStart'; clipId: string; at: number }
  /** Move the clip's right edge to composition sample `at`, moving srcEnd with it. */
  | { type: 'trimEnd'; clipId: string; at: number }
  /** Cut the clip in two at composition sample `at`; the right piece gets a fresh `${base}~n` id. */
  | { type: 'split'; clipId: string; at: number }
  | { type: 'delete'; clipId: string }
  /** Clip gain in dB, clamped to GAIN_DB_RANGE; null (or -Infinity) is silent. */
  | { type: 'setGain'; clipId: string; gainDb: number | null }
  /** Fade lengths in samples, clamped to the clip's maxFade; a side left out keeps its fade. */
  | { type: 'setFades'; clipId: string; fadeInSamples?: number; fadeOutSamples?: number }
  /** Move the clip by whole frames (keeping its sub-frame offset). */
  | { type: 'nudge'; clipId: string; frames: number }
  /**
   * Lay a new clip (an uploaded or picked take) on top at its `start`; it wins where it overlaps. `with` are the same
   * take's other pieces (a recorded take split where its picture stepped a frame), added in the same undo step. With
   * `keepTakes` (a punch-in), each new clip keeps the takes it covers as its alternatives, so they can be swapped back.
   */
  | { type: 'insert'; clip: NarrationClip; with?: readonly NarrationClip[]; keepTakes?: boolean }
  /** Put take `take` (1 = the oldest) of the clip's slot in its place, where that take was recorded. */
  | { type: 'swapTake'; clipId: string; take: number }

export type CommandResult =
  | { ok: true; op: NarrationOp; /** What happened, for the aria-live region. */ message: string }
  | { ok: false; reason: string }

/** The shortest clip a trim leaves: one frame. */
export const minClipSamples = (fps: number): number => Math.max(1, frameStart(1, fps))

const clock = (samples: number) => {
  const s = Math.max(0, samples / SAMPLE_RATE)
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}
const dbText = (db: number | null) =>
  db === null ? 'silent' : `${db > 0 ? '+' : ''}${Math.round(db * 10) / 10} dB`
const secText = (samples: number) => `${Math.round((samples / SAMPLE_RATE) * 100) / 100} s`

/** The op's clips, resolved, checked against the limits. */
function finish(op: NarrationOp, clips: NarrationClip[], ctx: EditContext, message: string): CommandResult {
  const resolved = resolve(clips)
  if (resolved.length > MAX_NARRATION_CLIPS)
    return { ok: false, reason: `A narration can have at most ${MAX_NARRATION_CLIPS} clips` }
  if (opTakeIds(resolved).length > MAX_NARRATION_TAKES)
    return { ok: false, reason: `A narration can use at most ${MAX_NARRATION_TAKES} takes` }
  const limit = outputLimit(ctx.baseSamples)
  if (outputEnd(resolved) > limit)
    return { ok: false, reason: `The narration can't run past ${formatTime(limit / SAMPLE_RATE)}` }
  if (resolved.some((c) => c.start < 0 || c.srcStart < 0))
    return { ok: false, reason: "A clip can't start before 0:00" }
  return { ok: true, op: { ...op, clips: resolved }, message }
}

/** `clips` with clip `id` replaced by `next`, moved last so it wins where it now overlaps. */
const lastWins = (clips: readonly NarrationClip[], id: string, next: NarrationClip) => [
  ...clips.filter((c) => c.id !== id),
  next,
]

const freshId = (clips: readonly NarrationClip[], id: string) => {
  const used = new Set(clips.map((c) => c.id))
  const base = id.replace(/~\d+$/, '')
  let n = 2
  while (used.has(`${base}~${n}`)) n++
  return `${base}~${n}`
}

const clampInt = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)))

/**
 * The takes the track plays in composition [from, to), oldest first: every clip there with its slot's takes, cut to
 * the range. What a punch-in over the range keeps as its alternatives.
 */
export function coveredTakes(clips: readonly NarrationClip[], from: number, to: number): TakeAlternative[] {
  const out: TakeAlternative[] = []
  for (const c of resolve(clips)) {
    if (clipEnd(c) <= from || c.start >= to) continue
    for (const t of slotTakes(c).takes) {
      const cut = cutAlternative(t, from, to)
      if (cut) out.push(cut)
    }
  }
  return out
}

/** Applies one command to `op`. Never throws on bad input; a rejected command reports why. */
export function applyCommand(op: NarrationOp, cmd: NarrationCommand, ctx: EditContext): CommandResult {
  const clips = op.clips
  if (cmd.type === 'insert') {
    const n = cmd.clip
    const all = [n, ...(cmd.with ?? [])]
    const ids = new Set(all.map((x) => x.id))
    if (ids.size < all.length || clips.some((x) => ids.has(x.id)))
      return { ok: false, reason: 'That clip is already there' }
    if (all.some((x) => !Number.isInteger(x.start) || !(clipLength(x) > 0)))
      return { ok: false, reason: 'Not a clip' }
    const placed = all.map((x) => {
      const at = { ...x, start: Math.max(0, x.start) }
      return cmd.keepTakes ? withAlternatives(at, coveredTakes(clips, at.start, clipEnd(at))) : at
    })
    return finish(op, [...clips, ...placed], ctx, `Clip added at ${clock(n.start)}`)
  }
  const c = clips.find((x) => x.id === cmd.clipId)
  if (!c) return { ok: false, reason: 'That clip is gone' }
  const minLen = minClipSamples(ctx.fps)
  switch (cmd.type) {
    case 'move':
    case 'nudge': {
      const to = cmd.type === 'move' ? cmd.start : nudge(c.start, cmd.frames, ctx.fps)
      if (!Number.isFinite(to)) return { ok: false, reason: 'Not a time' }
      const start = Math.max(0, Math.round(to))
      const from = cmd.type === 'move' ? cmd.srcStart : undefined
      if (from !== undefined && !Number.isFinite(from)) return { ok: false, reason: 'Not a time' }
      const srcStart = from === undefined ? c.srcStart : clampInt(from, 0, c.srcEnd - minLen)
      return finish(
        op,
        lastWins(clips, c.id, { ...c, srcStart, start }),
        ctx,
        `Clip moved to ${clock(start)}`,
      )
    }
    case 'trimStart': {
      if (!Number.isFinite(cmd.at)) return { ok: false, reason: 'Not a time' }
      // srcStart may go down to the take's start (and no earlier than composition 0), up to a frame before srcEnd.
      const lo = Math.max(0, c.srcStart - c.start)
      const hi = c.srcEnd - minLen
      if (hi < lo) return { ok: false, reason: 'The clip is too short to trim' }
      const srcStart = clampInt(c.srcStart + (cmd.at - c.start), lo, hi)
      const start = c.start + (srcStart - c.srcStart)
      return finish(
        op,
        lastWins(clips, c.id, { ...c, srcStart, start }),
        ctx,
        `Clip starts at ${clock(start)}`,
      )
    }
    case 'trimEnd': {
      if (!Number.isFinite(cmd.at)) return { ok: false, reason: 'Not a time' }
      const lo = c.srcStart + minLen
      const hi = Math.max(c.srcEnd, ctx.takeSamples.get(c.mediaId) ?? c.srcEnd)
      if (hi < lo) return { ok: false, reason: 'The clip is too short to trim' }
      const srcEnd = clampInt(c.srcStart + (cmd.at - c.start), lo, hi)
      const next = { ...c, srcEnd }
      return finish(op, lastWins(clips, c.id, next), ctx, `Clip ends at ${clock(clipEnd(next))}`)
    }
    case 'split': {
      const at = Math.round(cmd.at)
      if (!(at > c.start && at < clipEnd(c)))
        return { ok: false, reason: "The playhead isn't inside the clip" }
      const cut = c.srcStart + (at - c.start)
      // Each piece keeps its slot's other takes over its own part.
      const bare = withoutAlternatives(c)
      const left: NarrationClip = { ...bare, ...cutSlot(c, c.start, at), srcEnd: cut, fadeOutSamples: 0 }
      const right: NarrationClip = {
        ...bare,
        ...cutSlot(c, at, clipEnd(c)),
        id: freshId(clips, c.id),
        srcStart: cut,
        start: at,
        fadeInSamples: 0,
      }
      const i = clips.indexOf(c)
      return finish(op, [...clips.slice(0, i), left, right, ...clips.slice(i + 1)], ctx, 'Split')
    }
    case 'delete':
      return finish(
        op,
        clips.filter((x) => x.id !== c.id),
        ctx,
        'Deleted',
      )
    case 'setGain': {
      const v = cmd.gainDb
      if (v !== null && Number.isNaN(v)) return { ok: false, reason: 'Not a gain' }
      const gainDb =
        v === null || v === -Infinity ? null : Math.min(GAIN_DB_RANGE[1], Math.max(GAIN_DB_RANGE[0], v))
      return finish(
        op,
        clips.map((x) => (x === c ? { ...c, gainDb } : x)),
        ctx,
        `Gain ${dbText(gainDb)}`,
      )
    }
    case 'swapTake': {
      const { takes, own } = slotTakes(c)
      const i = Math.round(cmd.take) - 1
      const t = takes[i]
      if (!t || !Number.isFinite(cmd.take)) return { ok: false, reason: 'That take is gone' }
      if (i === own) return finish(op, clips, ctx, `Take ${i + 1} is playing`)
      const rest = takes.filter((_, k) => k !== i)
      // The take sounds where it was recorded; the one it replaces keeps its own place among the alternatives.
      const next: NarrationClip = {
        ...withAlternatives(withoutAlternatives(c), rest),
        ...(i < rest.length ? { take: i + 1 } : {}),
        mediaId: t.mediaId,
        srcStart: t.srcStart,
        srcEnd: t.srcEnd,
        fit: t.fit,
        offsetSamples: t.offsetSamples,
        start: altStart(t),
      }
      return finish(op, lastWins(clips, c.id, next), ctx, `Take ${i + 1} of ${takes.length}`)
    }
    case 'setFades': {
      const m = maxFade(clipLength(c))
      const fade = (v: number | undefined, keep: number) =>
        v === undefined || !Number.isFinite(v) ? keep : clampInt(v, 0, m)
      const next = {
        ...c,
        fadeInSamples: fade(cmd.fadeInSamples, c.fadeInSamples),
        fadeOutSamples: fade(cmd.fadeOutSamples, c.fadeOutSamples),
      }
      return finish(
        op,
        clips.map((x) => (x === c ? next : x)),
        ctx,
        `Fades ${secText(next.fadeInSamples)} in, ${secText(next.fadeOutSamples)} out`,
      )
    }
  }
}

// ---- undo / redo

/** Undo depth; the oldest entry goes first. */
export const MAX_UNDO = 200

export interface EditorHistory {
  past: NarrationOp[]
  present: NarrationOp
  future: NarrationOp[]
  /**
   * The continuous gesture (a drag) the last command belonged to: its commands all apply to `base`, the op before
   * the gesture, and share one undo entry (`pushed` once it has changed anything).
   */
  group: { key: string; base: NarrationOp; pushed: boolean } | null
  /** The last command's outcome, for the live region; `n` counts commands so repeats re-announce. */
  last: { ok: boolean; message: string; n: number } | null
}

export type EditorAction =
  /** A command; with `coalesce`, consecutive commands with the same key are one gesture and one undo entry. */
  | { type: 'command'; command: NarrationCommand; ctx: EditContext; coalesce?: string }
  /** Ends the current gesture, so the next command starts a new undo entry. */
  | { type: 'commit' }
  | { type: 'undo' }
  | { type: 'redo' }
  /** Replaces the op and clears the stack (a new draft from the server). */
  | { type: 'reset'; op: NarrationOp }

export function initHistory(op: NarrationOp): EditorHistory {
  return { past: [], present: { ...op, clips: resolve(op.clips) }, future: [], group: null, last: null }
}

const sameClip = (a: NarrationClip, b: NarrationClip) =>
  a.id === b.id &&
  a.mediaId === b.mediaId &&
  a.srcStart === b.srcStart &&
  a.srcEnd === b.srcEnd &&
  a.start === b.start &&
  a.gainDb === b.gainDb &&
  a.fadeInSamples === b.fadeInSamples &&
  a.fadeOutSamples === b.fadeOutSamples &&
  a.offsetSamples === b.offsetSamples &&
  a.fit === b.fit &&
  a.alternatives === b.alternatives &&
  a.take === b.take

/** Whether two ops place the same clips (the tracks aren't edited here). */
export const sameClips = (a: NarrationOp, b: NarrationOp): boolean =>
  a.clips.length === b.clips.length && a.clips.every((c, i) => !!b.clips[i] && sameClip(c, b.clips[i]))

const bounded = (past: NarrationOp[]) => (past.length > MAX_UNDO ? past.slice(past.length - MAX_UNDO) : past)
const said = (h: EditorHistory, ok: boolean, message: string) => ({ ok, message, n: (h.last?.n ?? 0) + 1 })

export function editorReducer(h: EditorHistory, action: EditorAction): EditorHistory {
  switch (action.type) {
    case 'command': {
      const key = action.coalesce
      const group = key && h.group?.key === key ? h.group : null
      const base = group ? group.base : h.present
      const r = applyCommand(base, action.command, action.ctx)
      // A rejected step of a drag keeps the drag's last good position.
      if (!r.ok)
        return {
          ...h,
          group: key ? (group ?? { key, base, pushed: false }) : null,
          last: said(h, false, r.reason),
        }
      const changed = !sameClips(r.op, base)
      const pushed = group?.pushed ?? false
      let past = h.past
      if (changed && !pushed) past = bounded([...past, base])
      if (!changed && pushed) past = past.slice(0, -1)
      return {
        past,
        present: changed ? r.op : base,
        future: changed || pushed ? [] : h.future,
        group: key ? { key, base, pushed: changed } : null,
        last: said(h, true, changed ? r.message : 'No change'),
      }
    }
    case 'commit':
      return h.group ? { ...h, group: null } : h
    case 'undo': {
      const prev = h.past[h.past.length - 1]
      if (!prev) return { ...h, group: null, last: said(h, false, 'Nothing to undo') }
      return {
        past: h.past.slice(0, -1),
        present: prev,
        future: [h.present, ...h.future],
        group: null,
        last: said(h, true, 'Undone'),
      }
    }
    case 'redo': {
      const next = h.future[0]
      if (!next) return { ...h, group: null, last: said(h, false, 'Nothing to redo') }
      return {
        past: bounded([...h.past, h.present]),
        present: next,
        future: h.future.slice(1),
        group: null,
        last: said(h, true, 'Redone'),
      }
    }
    case 'reset':
      return initHistory(action.op)
  }
}

// ---- keys

export type KeyAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'split' }
  | { type: 'delete' }
  | { type: 'nudge'; frames: number }
  | { type: 'menu' }

/**
 * The editing shortcut a key press means (§5.5): Cmd+Z / Shift+Cmd+Z on a Mac, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
 * elsewhere; S splits; Delete / Backspace deletes; ←/→ nudge a frame (Shift: 10); the ContextMenu key or Shift+F10
 * opens the clip menu. Null for anything else (and for keys with the other platform's modifier).
 */
export function keyAction(
  e: { key: string; altKey: boolean; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  mac: boolean,
): KeyAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (mod && !e.altKey) {
    if (key === 'z') return { type: e.shiftKey ? 'redo' : 'undo' }
    if (key === 'y' && !mac && !e.shiftKey) return { type: 'redo' }
    return null
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  if (key === 's') return { type: 'split' }
  if (key === 'Delete' || key === 'Backspace') return { type: 'delete' }
  if (key === 'ArrowLeft' || key === 'ArrowRight')
    return { type: 'nudge', frames: (key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1) }
  if (key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) return { type: 'menu' }
  return null
}

/** Whether a key event's target takes text (inputs, textareas, selects, contenteditable), so shortcuts stand aside. */
export function isEditableTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName.toUpperCase())
}
