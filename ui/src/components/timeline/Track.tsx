// A lane's header (name, volume, mute, and solo or duck where the lane has them) and the lane row its clips sit in.
// Headers sit in a fixed column beside the scrolling lanes; both use the same row heights (timeline.css).
import { ActionIcon, Slider, Switch, Text, Tooltip } from '@mantine/core'
import { IconVolume, IconVolumeOff } from '@tabler/icons-react'
import type { DragEvent, PointerEvent, ReactNode } from 'react'
import type { LaneId } from './types'

export interface VolumeControl {
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  disabled?: boolean
}

export interface TrackProps {
  lane: LaneId
  name: string
  /** A short state note under the name ("Read-only", "No music"). */
  note?: string
  volume?: VolumeControl
  muted?: boolean
  onMute?: (muted: boolean) => void
  solo?: boolean
  onSolo?: (solo: boolean) => void
  duck?: { on: boolean; onToggle: (on: boolean) => void; amount: VolumeControl }
}

function Level(p: { label: string; control: VolumeControl }) {
  const c = p.control
  return (
    <Slider
      className="va-tl-level"
      size="xs"
      min={c.min}
      max={c.max}
      step={c.step}
      value={c.value}
      disabled={c.disabled === true}
      label={c.format}
      thumbLabel={p.label}
      onChange={c.onChange}
    />
  )
}

/** The lane header. */
export function Track(p: TrackProps) {
  return (
    <div className="va-tl-head" data-lane={p.lane} role="group" aria-label={`${p.name} track`}>
      <div className="va-tl-head-row">
        <Text size="xs" fw={600} className="va-tl-head-name" truncate>
          {p.name}
        </Text>
        {p.onSolo ? (
          <Tooltip label={p.solo ? 'Stop soloing' : 'Solo: hear only this track'}>
            <ActionIcon
              size="sm"
              variant={p.solo ? 'filled' : 'subtle'}
              color={p.solo ? 'yellow' : 'gray'}
              aria-label={`Solo ${p.name}`}
              aria-pressed={!!p.solo}
              onClick={() => p.onSolo?.(!p.solo)}
            >
              <span className="va-tl-solo">S</span>
            </ActionIcon>
          </Tooltip>
        ) : null}
        {p.onMute ? (
          <ActionIcon
            size="sm"
            variant="subtle"
            color={p.muted ? 'red' : 'gray'}
            aria-label={`Mute ${p.name}`}
            aria-pressed={!!p.muted}
            onClick={() => p.onMute?.(!p.muted)}
          >
            {p.muted ? <IconVolumeOff size={14} /> : <IconVolume size={14} />}
          </ActionIcon>
        ) : null}
      </div>
      {p.note ? (
        <Text size="xs" c="var(--va-faint)" truncate>
          {p.note}
        </Text>
      ) : null}
      {p.volume ? <Level label={`${p.name} volume`} control={p.volume} /> : null}
      {p.duck ? (
        <div className="va-tl-head-row">
          <Switch
            size="xs"
            label="Duck"
            checked={p.duck.on}
            onChange={(e) => p.duck?.onToggle(e.currentTarget.checked)}
            aria-label={`Duck ${p.name} under narration`}
          />
          {p.duck.on ? <Level label={`${p.name} duck amount`} control={p.duck.amount} /> : null}
        </div>
      ) : null}
    </div>
  )
}

/** The lane row. */
export function Lane(p: {
  lane: LaneId
  name: string
  muted?: boolean
  children: ReactNode
  onPointerDown?: (e: PointerEvent<HTMLDivElement>) => void
  /** Files being dragged over the lane (it highlights) and dropped on it. */
  drop?: {
    active: boolean
    onDragOver: (e: DragEvent<HTMLDivElement>) => void
    onDragLeave: (e: DragEvent<HTMLDivElement>) => void
    onDrop: (e: DragEvent<HTMLDivElement>) => void
  }
}) {
  return (
    <div
      className="va-tl-lane"
      data-lane={p.lane}
      data-muted={p.muted ? '' : undefined}
      data-drop={p.drop?.active ? '' : undefined}
      role="group"
      aria-label={`${p.name} lane`}
      onPointerDown={p.onPointerDown}
      onDragOver={p.drop?.onDragOver}
      onDragLeave={p.drop?.onDragLeave}
      onDrop={p.drop?.onDrop}
    >
      {p.children}
    </div>
  )
}
