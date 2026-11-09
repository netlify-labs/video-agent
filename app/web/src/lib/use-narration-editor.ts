// The narration editor's state (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3, §5.5): the op with its
// local undo/redo stack (narration-commands.ts), the selected clip, the clip menu, and the live-region text. It turns
// the timeline's clip events into commands: a drag past a few pixels moves or trims with snapping (Alt / Option turns
// it off) as one undo entry; keys on a focused clip split, delete, nudge and open the menu; Cmd/Ctrl+Z, Shift+Cmd+Z
// and Ctrl+Y work anywhere outside a text field.
import { useCallback, useEffect, useRef, useState } from 'react'
import { clipEnd, clipLength, SAMPLE_RATE, type NarrationOp } from '../../../server/lib/timeline'
import type { ClipCommand } from '../components/timeline'
import {
  editorReducer,
  initHistory,
  isEditableTarget,
  keyAction,
  type EditContext,
  type EditorAction,
  type EditorHistory,
  type NarrationCommand,
} from './narration-commands'
import { snap, snapMove, snapTargets } from './timeline-snap'

/** A press must travel this far (CSS px) before it drags, so a click only selects. */
export const DRAG_THRESHOLD_PX = 3

export interface NarrationEditorOptions extends EditContext {
  /** Composition sample under the playhead: where S splits, and a snap target. */
  playhead: number
  /** The composition's beats in seconds, as snap targets. */
  beats?: readonly { start: number; duration: number }[]
  /** Someone else holds the narration lock: the keyboard shortcuts do nothing (the section refuses the rest). */
  readOnly?: boolean
}

export interface ClipMenuState {
  clipId: string
  /** Viewport position to open at. */
  x: number
  y: number
}

export interface DispatchOptions {
  /** Commands with the same key are one gesture: one undo entry, applied to the op before it. */
  coalesce?: string
  /** Don't announce (the steps of a drag). */
  quiet?: boolean
}

export interface NarrationEditor {
  op: NarrationOp
  /** Runs a command; `op` is the op after it (the clips, as the next render shows them). */
  dispatch: (
    command: NarrationCommand,
    opts?: DispatchOptions,
  ) => { ok: boolean; message: string; op?: NarrationOp }
  /** Ends a coalesced gesture (an inspector field losing focus). */
  commit: () => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  selected: string | null
  setSelected: (clipId: string | null) => void
  onClipCommand: (command: ClipCommand) => void
  menu: ClipMenuState | null
  openMenu: (clipId: string, x?: number, y?: number) => void
  closeMenu: () => void
  /** The last action, for an aria-live region; `n` changes on every announcement. */
  announcement: { text: string; n: number }
  playhead: number
  fps: number
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

const clipElement = (id: string) =>
  typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLElement>(`.va-tl-clip[data-clip-id="${CSS.escape(id)}"]`)

/** Focuses a clip after the next render (it may only mount once selected). */
export const focusClip = (id: string) => requestAnimationFrame(() => clipElement(id)?.focus())

interface Drag {
  pointerId: number
  clipId: string
  part: 'body' | 'start' | 'end'
  downSample: number
  start: number
  end: number
  moved: boolean
  key: string
}

export function useNarrationEditor(initialOp: NarrationOp, opts: NarrationEditorOptions): NarrationEditor {
  const [history, setHistory] = useState<EditorHistory>(() => initHistory(initialOp))
  const ref = useRef(history)
  const live = useRef(opts)
  live.current = opts
  const [selected, setSelectedState] = useState<string | null>(null)
  const selectedRef = useRef(selected)
  const [menu, setMenuState] = useState<ClipMenuState | null>(null)
  const menuRef = useRef(menu)
  const setMenu = useCallback((m: ClipMenuState | null) => {
    menuRef.current = m
    setMenuState(m)
  }, [])
  const [announcement, setAnnouncement] = useState({ text: '', n: 0 })
  const drag = useRef<Drag | null>(null)
  const gestures = useRef(0)

  const setSelected = useCallback((id: string | null) => {
    selectedRef.current = id
    setSelectedState(id)
  }, [])
  const announce = useCallback((text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 })), [])

  const run = useCallback((action: EditorAction) => {
    const next = editorReducer(ref.current, action)
    ref.current = next
    setHistory(next)
    return next
  }, [])

  const dispatch = useCallback(
    (command: NarrationCommand, o: DispatchOptions = {}) => {
      const o2 = live.current
      const before = ref.current.present.clips
      const next = run({
        type: 'command',
        command,
        ctx: { takeSamples: o2.takeSamples, baseSamples: o2.baseSamples, fps: o2.fps },
        ...(o.coalesce ? { coalesce: o.coalesce } : {}),
      })
      const last = next.last ?? { ok: false, message: '' }
      if (last.ok && command.type === 'delete') {
        // Keep keyboard focus in the lane: select (and focus) the clip after the deleted one, or before it.
        const i = before.findIndex((c) => c.id === command.clipId)
        const neighbour = next.present.clips[i] ?? next.present.clips[i - 1]
        setSelected(neighbour?.id ?? null)
        if (neighbour) focusClip(neighbour.id)
      }
      // A new clip comes in selected, so its gain and fades are one step away.
      if (last.ok && command.type === 'insert') setSelected(command.clip.id)
      if (!o.quiet) announce(last.message)
      return { ok: last.ok, message: last.message, op: next.present }
    },
    [run, announce, setSelected],
  )

  const commit = useCallback(() => {
    run({ type: 'commit' })
  }, [run])
  const undo = useCallback(() => {
    announce(run({ type: 'undo' }).last?.message ?? '')
  }, [run, announce])
  const redo = useCallback(() => {
    announce(run({ type: 'redo' }).last?.message ?? '')
  }, [run, announce])

  const openMenu = useCallback(
    (clipId: string, x?: number, y?: number) => {
      const r = clipElement(clipId)?.getBoundingClientRect()
      setSelected(clipId)
      setMenu({ clipId, x: x ?? (r ? r.left + Math.min(r.width / 2, 24) : 0), y: y ?? (r ? r.bottom : 0) })
    },
    [setSelected, setMenu],
  )
  const closeMenu = useCallback(() => {
    // Focus goes back to the clip (or, once deleted, to the neighbour dispatch picked).
    const m = menuRef.current
    setMenu(null)
    const id = m && ref.current.present.clips.some((c) => c.id === m.clipId) ? m.clipId : selectedRef.current
    if (id) focusClip(id)
  }, [setMenu])

  /** The shortcut-level actions on one clip, shared by its keys and the global listener. */
  const act = useCallback(
    (action: NonNullable<ReturnType<typeof keyAction>>, clipId: string | null): boolean => {
      switch (action.type) {
        case 'undo':
          undo()
          return true
        case 'redo':
          redo()
          return true
        case 'split':
          if (!clipId) return false
          dispatch({ type: 'split', clipId, at: live.current.playhead })
          return true
        case 'delete':
          if (!clipId) return false
          dispatch({ type: 'delete', clipId })
          return true
        case 'nudge':
          if (!clipId) return false
          dispatch({ type: 'nudge', clipId, frames: action.frames })
          return true
        case 'menu':
          if (!clipId) return false
          openMenu(clipId)
          return true
      }
    },
    [undo, redo, dispatch, openMenu],
  )

  const onClipCommand = useCallback(
    (cmd: ClipCommand) => {
      if (cmd.type === 'menu') {
        openMenu(cmd.clipId, cmd.clientX, cmd.clientY)
        return
      }
      if (cmd.type === 'key') {
        if (cmd.key === 'Escape' && menuRef.current) {
          closeMenu()
          cmd.handled()
          return
        }
        const action = keyAction(cmd, isMac())
        // Undo and redo are left to the window listener, so they work the same wherever focus is.
        if (!action || action.type === 'undo' || action.type === 'redo') return
        if (act(action, cmd.clipId)) cmd.handled()
        return
      }
      const d = drag.current
      if (cmd.phase === 'down') {
        const c = ref.current.present.clips.find((x) => x.id === cmd.clipId)
        if (!c) return
        run({ type: 'commit' })
        drag.current = {
          pointerId: cmd.pointerId,
          clipId: c.id,
          part: cmd.part,
          downSample: cmd.sample,
          start: c.start,
          end: clipEnd(c),
          moved: false,
          key: `drag:${++gestures.current}`,
        }
        return
      }
      if (!d || d.pointerId !== cmd.pointerId || d.clipId !== cmd.clipId) return
      if (cmd.phase === 'up' || cmd.phase === 'cancel') {
        drag.current = null
        if (!d.moved) return
        if (cmd.phase === 'cancel') {
          // Back to where the drag began (the gesture's own base), dropping its undo entry.
          const back: NarrationCommand =
            d.part === 'body'
              ? { type: 'move', clipId: d.clipId, start: d.start }
              : d.part === 'start'
                ? { type: 'trimStart', clipId: d.clipId, at: d.start }
                : { type: 'trimEnd', clipId: d.clipId, at: d.end }
          dispatch(back, { coalesce: d.key, quiet: true })
        }
        const last = ref.current.last
        run({ type: 'commit' })
        announce(cmd.phase === 'cancel' ? 'Drag cancelled' : (last?.message ?? ''))
        return
      }
      const delta = cmd.sample - d.downSample
      if (!d.moved && (Math.abs(delta) / SAMPLE_RATE) * cmd.pxPerSec < DRAG_THRESHOLD_PX) return
      d.moved = true
      const o = live.current
      // Targets from the op before the drag (its group base), less the dragged clip.
      const base = ref.current.group?.key === d.key ? ref.current.group.base : ref.current.present
      const targets = snapTargets({
        ...(o.beats ? { beats: o.beats } : {}),
        clips: base.clips,
        playhead: o.playhead,
        exclude: new Set([d.clipId]),
      })
      const snapOpts = { disabled: cmd.altKey }
      let command: NarrationCommand
      if (d.part === 'body') {
        const s = snapMove(d.start + delta, d.end - d.start, targets, cmd.pxPerSec, snapOpts)
        command = { type: 'move', clipId: d.clipId, start: s.sample }
      } else if (d.part === 'start') {
        command = {
          type: 'trimStart',
          clipId: d.clipId,
          at: snap(d.start + delta, targets, cmd.pxPerSec, snapOpts).sample,
        }
      } else {
        command = {
          type: 'trimEnd',
          clipId: d.clipId,
          at: snap(d.end + delta, targets, cmd.pxPerSec, snapOpts).sample,
        }
      }
      dispatch(command, { coalesce: d.key, quiet: true })
    },
    [act, announce, closeMenu, dispatch, openMenu, run],
  )

  // Undo/redo anywhere outside a text field; split and delete on the selected clip while focus is in the timeline
  // (a focused clip handles its own keys first and marks them handled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target) || live.current.readOnly) return
      const action = keyAction(e, isMac())
      if (!action) return
      if (action.type === 'undo' || action.type === 'redo') {
        e.preventDefault()
        act(action, null)
        return
      }
      if (action.type !== 'split' && action.type !== 'delete') return
      const inTimeline = e.target instanceof Element && !!e.target.closest('.va-tl')
      const id = selectedRef.current
      if (!inTimeline || !id || !ref.current.present.clips.some((c) => c.id === id)) return
      e.preventDefault()
      act(action, id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [act])

  const op = history.present
  const shownSelected = selected && op.clips.some((c) => c.id === selected) ? selected : null
  return {
    op,
    dispatch,
    commit,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    selected: shownSelected,
    setSelected,
    onClipCommand,
    menu: menu && op.clips.some((c) => c.id === menu.clipId) ? menu : null,
    openMenu,
    closeMenu,
    announcement,
    playhead: opts.playhead,
    fps: opts.fps,
  }
}

/** Whether `sample` is strictly inside the clip (where a split can go). */
export const canSplitAt = (op: NarrationOp, clipId: string, sample: number): boolean => {
  const c = op.clips.find((x) => x.id === clipId)
  return !!c && clipLength(c) > 1 && sample > c.start && sample < clipEnd(c)
}
