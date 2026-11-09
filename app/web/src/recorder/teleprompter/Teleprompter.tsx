// The teleprompter (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1 step 3, §5.3, owner decision 10): a DOM
// panel beside the picture while recording (PrompterLayout stacks it below on narrow windows), locked to the scenes.
// Give it the base composition and the voice-over script (lines.ts picks script or beat texts) and the picture's
// time: `time` as a prop, or `getTime` (e.g. pictureTime over the picture clock's anchors), polled every animation
// frame and re-rendered only when the shown lines change. The current line is highlighted, the next one dimmed
// NEXT_LEAD_SEC before its beat. Font size is adjustable (remembered in this browser); T toggles it, except while
// typing in a field. It's a visual aid: no live region, so a screen reader isn't talked over while recording.
import { ActionIcon, Group, Text, UnstyledButton } from '@mantine/core'
import { IconMinus, IconPlus } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Composition } from '../../../../server/lib/contract'
import { linesAt, prompterLines, type PrompterScript, type PrompterState } from './lines'
import './teleprompter.css'

export const FONT_SIZES = { min: 16, max: 64, step: 4, initial: 28 } as const
const FONT_KEY = 'va.prompter.fontSize'
/** Below this window width the prompter stacks under the picture. */
export const NARROW_MAX_PX = 900

export type PrompterLayoutKind = 'beside' | 'stacked'
export const prompterLayout = (width: number): PrompterLayoutKind =>
  width <= NARROW_MAX_PX ? 'stacked' : 'beside'

interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  repeat?: boolean
  target?: EventTarget | null
}

/** Whether a target takes typing: an input, a textarea, a select or anything contenteditable. */
export function isTextField(target: EventTarget | null | undefined): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null | undefined
  if (!el?.tagName) return false
  return el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName.toUpperCase())
}

/** A plain T press outside a text field toggles the prompter. */
export const isPrompterToggle = (e: KeyLike) =>
  (e.key === 't' || e.key === 'T') &&
  !e.ctrlKey &&
  !e.metaKey &&
  !e.altKey &&
  !e.repeat &&
  !isTextField(e.target)

const clampFont = (n: number) => Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, Math.round(n)))
function storedFont(): number {
  try {
    const v = Number(localStorage.getItem(FONT_KEY))
    return v ? clampFont(v) : FONT_SIZES.initial
  } catch {
    return FONT_SIZES.initial
  }
}

export interface TeleprompterProps {
  /** The base composition (read() output or its html). */
  composition: Composition | string
  /** versions.voiceover.script, or lines by beat id; null or left out: beat texts (or the composition's own lines). */
  script?: PrompterScript | null
  /** Composition seconds on screen. */
  time?: number
  /** Polled every frame instead of `time`; null holds the last state. */
  getTime?: () => number | null
  /** Controlled visibility; uncontrolled (shown, T toggles) when left out. */
  visible?: boolean
  onVisibleChange?: (visible: boolean) => void
  /** Initial font size in px (otherwise this browser's last, or 28). */
  fontSize?: number
}

export function Teleprompter({
  composition,
  script,
  time,
  getTime,
  visible,
  onVisibleChange,
  fontSize: initialFont,
}: TeleprompterProps) {
  const lines = useMemo(() => prompterLines(composition, script), [composition, script])
  const [state, setState] = useState<PrompterState>(() => linesAt(lines, time ?? 0))
  const [own, setOwn] = useState(true)
  const shown = visible ?? own
  const [font, setFont] = useState(() => (initialFont ? clampFont(initialFont) : storedFont()))

  // A time prop: recompute on every change.
  useEffect(() => {
    if (time !== undefined) setState(linesAt(lines, time))
  }, [lines, time])
  // A time source: poll it per frame, re-render only when what's shown changes.
  const poll = useRef(getTime)
  poll.current = getTime
  const hasSource = !!getTime
  useEffect(() => {
    if (!hasSource) return
    let raf = 0
    let last = ''
    const tick = () => {
      const t = poll.current?.()
      if (t !== null && t !== undefined) {
        const s = linesAt(lines, t)
        const key = `${s.current}:${s.next}`
        if (key !== last) {
          last = key
          setState(s)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lines, hasSource])

  const toggle = useRef<() => void>(() => undefined)
  toggle.current = () => {
    if (visible === undefined) setOwn((v) => !v)
    onVisibleChange?.(!shown)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPrompterToggle(e)) return
      e.preventDefault()
      toggle.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setFontSize = (n: number) => {
    const v = clampFont(n)
    setFont(v)
    try {
      localStorage.setItem(FONT_KEY, String(v))
    } catch {
      // private mode or blocked storage: this session only
    }
  }

  if (!shown)
    return (
      <div className="va-prompter" data-testid="teleprompter" data-visible="false">
        <UnstyledButton className="va-prompter-show" onClick={() => toggle.current()}>
          <Text size="sm" c="var(--va-muted)">
            Teleprompter hidden. Press T to show it.
          </Text>
        </UnstyledButton>
      </div>
    )

  const current = state.current === null ? null : lines[state.current]
  const next = state.next === null ? null : lines[state.next]
  return (
    <section className="va-prompter" aria-label="Teleprompter" data-testid="teleprompter" data-visible="true">
      <Group justify="space-between" gap="xs" className="va-prompter-bar">
        <Text size="xs" c="var(--va-muted)">
          {lines[0]?.source === 'script' ? 'Script' : 'On-screen text'} · T to hide
        </Text>
        <Group gap={4}>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Smaller text"
            disabled={font <= FONT_SIZES.min}
            onClick={() => setFontSize(font - FONT_SIZES.step)}
          >
            <IconMinus size={14} />
          </ActionIcon>
          <Text size="xs" c="var(--va-muted)" data-testid="prompter-font" miw={36} ta="center">
            {font}px
          </Text>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Larger text"
            disabled={font >= FONT_SIZES.max}
            onClick={() => setFontSize(font + FONT_SIZES.step)}
          >
            <IconPlus size={14} />
          </ActionIcon>
        </Group>
      </Group>
      <div className="va-prompter-lines" style={{ fontSize: font }}>
        {!lines.length ? (
          <p className="va-prompter-line" data-state="empty">
            This video has no script or on-screen text to read.
          </p>
        ) : null}
        {current ? (
          <p key={current.beat} className="va-prompter-line" data-state="current" data-beat={current.beat}>
            {current.text}
          </p>
        ) : null}
        {next ? (
          <p key={next.beat} className="va-prompter-line" data-state="next" data-beat={next.beat}>
            {next.text}
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** Watches the window width against NARROW_MAX_PX (beside until it can tell). */
export function usePrompterLayout(): PrompterLayoutKind {
  const query = `(max-width: ${NARROW_MAX_PX}px)`
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const m = window.matchMedia(query)
    const on = () => setNarrow(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return narrow ? 'stacked' : 'beside'
}

/** The recording layout: the picture on the left and the prompter on the right, or stacked on narrow windows. */
export function PrompterLayout({
  picture,
  prompter,
  layout,
}: {
  picture: ReactNode
  prompter: ReactNode
  /** Forced layout (tests); the window's width decides otherwise. */
  layout?: PrompterLayoutKind
}) {
  const auto = usePrompterLayout()
  const kind = layout ?? auto
  return (
    <div className="va-prompter-layout" data-layout={kind} data-testid="prompter-layout">
      <div className="va-prompter-picture">{picture}</div>
      <div className="va-prompter-side">{prompter}</div>
    </div>
  )
}
