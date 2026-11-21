// The Look choice (plan 2026-11-04-looks §6): a control showing the current look, and a picker of cards. Opening the
// picker loads posters only; a card's clip is fetched when it's hovered or focused (and never auto-plays with reduced
// motion). Reused by New video, Restyle and Remix.
import { ActionIcon, Button, Modal, Text, UnstyledButton } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconPlayerPlay, IconRobot } from '@tabler/icons-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import { $api } from '../api/client'
import {
  aspectNote,
  defaultLook,
  lookMark,
  pickable,
  sortForTemplate,
  type Look,
  type LookMark,
  type Looks,
} from '../lib/looks'
import './look-picker.css'

const TEMPLATE_LABEL: Record<string, string> = {
  launch: 'a launch',
  tutorial: 'a tutorial',
  social: 'a social clip',
  changelog: 'a changelog',
  sales: 'sales',
  other: 'this plan',
}

/** The catalog, when this deployment has looks; undefined while loading or when it has none. */
export function useLooks(): Looks | undefined {
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  const on = config.data?.features.includes('looks') === true
  const looks = $api.useQuery('get', '/api/v1/looks', {}, { enabled: on, staleTime: 60_000 })
  return on ? looks.data : undefined
}

/** What a create shows for an untouched Look: the admin default (or none). */
export const shownLook = (data: Looks | undefined, value: string | null | undefined): Look | null =>
  value === undefined
    ? defaultLook(data)
    : value === null
      ? null
      : (data?.looks.find((l) => l.id === value) ?? null)

function LookCard(props: {
  look: Look
  fits: string | null
  selected: boolean
  mark: LookMark
  onPick: () => void
}) {
  const { look } = props
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [active, setActive] = useState(false)
  const [played, setPlayed] = useState(false)
  // The clip's src is set only once wanted, so opening the picker fetches posters alone.
  const play = look.preview.mp4 && (reduced ? played : active)
  const note = aspectNote(look)
  return (
    <div className="va-look-card" data-selected={props.selected || undefined}>
      <UnstyledButton
        className="va-look-pick va-raised"
        data-look={look.id}
        aria-pressed={props.selected}
        disabled={props.mark === 'current'}
        onClick={props.onPick}
        // A mouse hover previews; on touch a tap picks, so a tap's emulated hover mustn't start a clip.
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') setActive(true)
        }}
        onPointerLeave={() => {
          setActive(false)
          setPlayed(false)
        }}
        onFocus={() => {
          setActive(true)
        }}
        onBlur={() => {
          setActive(false)
        }}
      >
        <div className="va-look-frame">
          {look.preview.poster ? <img src={look.preview.poster} alt="" loading="lazy" /> : null}
          {play ? (
            <video src={look.preview.mp4 ?? undefined} preload="none" muted loop playsInline autoPlay />
          ) : null}
        </div>
        <div className="va-look-text">
          <Text size="sm" fw={600}>
            {look.name}
            {props.mark ? <span className="va-look-mark">{MARK_LABEL[props.mark]}</span> : null}
          </Text>
          <Text size="xs" c="var(--va-muted)" lineClamp={2}>
            {look.description}
          </Text>
          {look.tags.length ? (
            <Text size="xs" c="var(--va-faint)" mt={4}>
              {look.tags.slice(0, 3).join(' · ')}
            </Text>
          ) : null}
          {props.fits ? (
            <Text size="xs" c="var(--va-accent-ink)" mt={4}>
              Fits {props.fits}
            </Text>
          ) : null}
          {note ? (
            <Text size="xs" c="var(--va-faint)" mt={4}>
              {note}
            </Text>
          ) : null}
        </div>
      </UnstyledButton>
      {reduced && look.preview.mp4 && !played ? (
        <ActionIcon
          className="va-look-play"
          variant="filled"
          color="dark"
          aria-label={`Play the ${look.name} preview`}
          onClick={() => {
            setPlayed(true)
          }}
        >
          <IconPlayerPlay size={14} />
        </ActionIcon>
      ) : null}
    </div>
  )
}

const MARK_LABEL = { current: 'Current', updated: 'Updated' } as const

/**
 * The cards: None first, then the enabled looks (those made for the plan's template first). `value` undefined: none
 * picked yet. With `current` (a restyle), the version's own look is marked and can't be picked again at the same hash.
 */
export function LookPicker(props: {
  looks: readonly Look[]
  value: string | null | undefined
  onPick: (id: string | null) => void
  template?: string | null | undefined
  current?: { id: string; hash: string } | null | undefined
}) {
  const noneMark = props.current === null ? 'current' : null
  const grid = useRef<HTMLDivElement>(null)
  const rows = sortForTemplate(pickable(props.looks), props.template)
  const fits = props.template ? (TEMPLATE_LABEL[props.template] ?? null) : null

  // Arrow keys move between cards (up and down by a row); Enter or Space picks the focused one.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 } as Record<string, number>)[e.key]
    if (!dir || !grid.current) return
    const cards = [...grid.current.querySelectorAll<HTMLElement>('.va-look-pick:not(:disabled)')]
    const at = cards.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    e.preventDefault()
    const cols = getComputedStyle(grid.current).gridTemplateColumns.split(' ').length || 1
    // ±1 is a card, ±2 a row.
    const step = Math.abs(dir) === 2 ? Math.sign(dir) * cols : dir
    cards[Math.min(cards.length - 1, Math.max(0, at + step))]?.focus()
  }

  return (
    <div className="va-look-grid" role="group" aria-label="Looks" ref={grid} onKeyDown={onKeyDown}>
      <div className="va-look-card" data-selected={props.value === null || undefined}>
        <UnstyledButton
          className="va-look-pick va-raised"
          data-look="none"
          aria-pressed={props.value === null}
          disabled={noneMark === 'current'}
          onClick={() => {
            props.onPick(null)
          }}
        >
          <div className="va-look-frame va-look-none">
            <IconRobot size={44} stroke={1.5} aria-hidden />
          </div>
          <div className="va-look-text">
            <Text size="sm" fw={600}>
              Agent decides
              {noneMark ? <span className="va-look-mark">Current</span> : null}
            </Text>
            <Text size="xs" c="var(--va-muted)">
              No set look: the agent picks a style that fits your prompt.
            </Text>
          </div>
        </UnstyledButton>
      </div>
      {rows.map((r) => (
        <LookCard
          key={r.look.id}
          look={r.look}
          fits={r.fits ? fits : null}
          selected={props.value === r.look.id}
          mark={lookMark(r.look, props.current)}
          onPick={() => {
            props.onPick(r.look.id)
          }}
        />
      ))}
    </div>
  )
}

/**
 * The settings-row control: the current look's poster and name, opening the picker. `value` undefined means untouched
 * (the request leaves look out and the server default applies, or with `inherit`, the source's look); null is None.
 */
export function LookControl(props: {
  value: string | null | undefined
  onChange: (id: string | null) => void
  /** What untouched means when it isn't the admin default: a remix keeps its source version's look. */
  inherit?: { id: string; name: string } | null
  template?: string | null | undefined
  disabled?: boolean
  label?: string
  hint?: string | undefined
  /** Only these of the catalog's looks (a demo's picker: looksForDemo). */
  only?: (looks: readonly Look[]) => Look[]
}) {
  const data = useLooks()
  const [open, setOpen] = useState(false)
  const looks = data ? (props.only ? props.only(data.looks) : data.looks) : []
  if (!data || pickable(looks).length === 0) return null
  const inherited = props.value === undefined && props.inherit !== undefined
  const catalogLook = (id: string | undefined) => data.looks.find((l) => l.id === id) ?? null
  const shown = inherited
    ? props.inherit
      ? {
          name: props.inherit.name,
          id: props.inherit.id,
          poster: catalogLook(props.inherit.id)?.preview.poster,
        }
      : null
    : (() => {
        const l = shownLook(data, props.value)
        return l ? { name: l.name, id: l.id, poster: l.preview.poster } : null
      })()
  return (
    <div>
      <Text size="sm" fw={500} mb={8}>
        {props.label ?? 'Look'}
      </Text>
      <Button
        variant="default"
        aria-haspopup="dialog"
        disabled={props.disabled === true}
        onClick={() => {
          setOpen(true)
        }}
        leftSection={
          shown?.poster ? (
            <img className="va-look-thumb" src={shown.poster} alt="" />
          ) : shown ? null : (
            <IconRobot size={18} stroke={1.5} aria-hidden />
          )
        }
        data-testid="look-control"
      >
        Look: {shown?.name ?? 'Agent decides'}
      </Button>
      {props.hint ? (
        <Text size="xs" c="var(--va-faint)" mt={6}>
          {props.hint}
        </Text>
      ) : null}
      <Modal
        opened={open}
        onClose={() => {
          setOpen(false)
        }}
        title="Pick a look"
        size="min(1200px, 94vw)"
        closeButtonProps={{ 'aria-label': 'Close' }}
        centered
      >
        <LookPicker
          looks={looks}
          value={shown?.id ?? null}
          template={props.template}
          onPick={(id) => {
            props.onChange(id)
            setOpen(false)
          }}
        />
      </Modal>
    </div>
  )
}
