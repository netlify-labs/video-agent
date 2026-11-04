// Keyboard transport for the players (the video page and the editor's preview): Space plays and pauses, ← and → step
// a second (Shift: five), like a video editor. Keys belong to whatever has focus first: typing, a control with its own
// keys (sliders, tabs, menus, the timeline's ruler and clips) or the browser's own video controls. Space on a button
// presses the button, as always.
import { useEffect, useRef } from 'react'

/** Elements that use these keys themselves. */
const OWN_KEYS =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="tab"], [role="radio"], [role="option"], [role="menuitem"], [role="textbox"], [role="listbox"], video, .va-tl-ruler, .va-tl-clip'

/** True when the focused element handles this key itself. */
export function ownsKey(target: EventTarget | null, key: string): boolean {
  const el = target as Element | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.closest(OWN_KEYS)) return true
  // Space presses a focused button or link; the arrows are free.
  return key === ' ' && el.closest('button, a[href], [role="button"]') !== null
}

export interface MediaKeys {
  /** Off while the player isn't shown (or isn't ready); a function is asked at each key press. */
  enabled: boolean | (() => boolean)
  toggle: () => void
  /** Moves the playhead by this many seconds (negative: back). */
  seekBy: (seconds: number) => void
}

/** Space, ← and → for one player, on the whole page, while `enabled`. */
export function useMediaKeys(keys: MediaKeys) {
  const current = useRef(keys)
  current.current = keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = current.current
      if (
        !(typeof k.enabled === 'function' ? k.enabled() : k.enabled) ||
        e.defaultPrevented ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return
      if (e.key !== ' ' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      // A dialog or menu is open: its keys are its own.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      if (ownsKey(e.target, e.key)) return
      e.preventDefault()
      if (e.key === ' ') k.toggle()
      else k.seekBy((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1))
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}
