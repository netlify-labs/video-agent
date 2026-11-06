// The narration editor's controls around the timeline (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3,
// §5.5): the clip menu (right-click, the ContextMenu key or Shift+F10 on a focused clip) mirroring every clip action,
// an inspector with the selected clip's gain and fades, and the aria-live region announcing what each action did. A
// clip with take alternatives (punch-ins over its range) gets Takes ▸ Take N, newest first, to swap in place.
// All of them act through useNarrationEditor, so everything they do is undoable.
import { Button, Group, Kbd, Menu, NumberInput, Text } from '@mantine/core'
import { IconCheck } from '@tabler/icons-react'
import {
  clipEnd,
  GAIN_DB_RANGE,
  maxFade,
  clipLength,
  SAMPLE_RATE,
  slotTakes,
  type NarrationClip,
} from '../../../../src/lib/timeline'
import { useRef, type ReactNode } from 'react'
import { canSplitAt, focusClip, type NarrationEditor } from '../../lib/use-narration-editor'

const FADE_STEP_SAMPLES = SAMPLE_RATE / 2

/** The clip menu, opened by the editor at a viewport position. */
export function ClipMenu({ editor }: { editor: NarrationEditor }) {
  const m = editor.menu
  const clip = m ? editor.op.clips.find((c) => c.id === m.clipId) : undefined
  const run = (fn: (clipId: string) => void) => () => {
    if (clip) fn(clip.id)
  }
  const gain = clip?.gainDb ?? null
  const fade = clip ? Math.min(FADE_STEP_SAMPLES, maxFade(clipLength(clip))) : 0
  const slot = clip?.alternatives?.length ? slotTakes(clip) : null
  // The dropdown holds focus until its exit transition ends; focus goes back to the clip (or the one selected after
  // a delete) only then, or it would be lost when the dropdown unmounts.
  const selected = useRef(editor.selected)
  selected.current = editor.selected
  return (
    <Menu
      opened={!!clip}
      onChange={(open) => {
        if (!open) editor.closeMenu()
      }}
      position="bottom-start"
      returnFocus={false}
      transitionProps={{
        onExited: () => {
          if (selected.current) focusClip(selected.current)
        },
      }}
      withinPortal
    >
      <Menu.Target>
        <div
          aria-hidden
          style={{
            position: 'fixed',
            left: m?.x ?? 0,
            top: m?.y ?? 0,
            width: 1,
            height: 1,
            pointerEvents: 'none',
          }}
        />
      </Menu.Target>
      <Menu.Dropdown aria-label="Clip actions" data-testid="clip-menu">
        <Menu.Item
          disabled={!clip || !canSplitAt(editor.op, clip.id, editor.playhead)}
          rightSection={<Kbd size="xs">S</Kbd>}
          onClick={run((clipId) => editor.dispatch({ type: 'split', clipId, at: editor.playhead }))}
        >
          Split at playhead
        </Menu.Item>
        {slot ? (
          <Menu.Sub position="right-start">
            <Menu.Sub.Target>
              <Menu.Sub.Item data-testid="clip-menu-takes">Takes ({slot.takes.length})</Menu.Sub.Item>
            </Menu.Sub.Target>
            <Menu.Sub.Dropdown aria-label="Takes" data-testid="clip-menu-takes-list">
              {slot.takes
                .map((_, i) => i)
                .reverse()
                .map((i) => (
                  <Menu.Item
                    key={i}
                    aria-current={i === slot.own ? 'true' : undefined}
                    leftSection={i === slot.own ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
                    onClick={run((clipId) => editor.dispatch({ type: 'swapTake', clipId, take: i + 1 }))}
                  >
                    Take {i + 1}
                  </Menu.Item>
                ))}
            </Menu.Sub.Dropdown>
          </Menu.Sub>
        ) : null}
        <Menu.Label>Nudge</Menu.Label>
        {[
          [-1, 'Nudge left 1 frame', '←'],
          [1, 'Nudge right 1 frame', '→'],
          [-10, 'Nudge left 10 frames', '⇧←'],
          [10, 'Nudge right 10 frames', '⇧→'],
        ].map(([frames, label, key]) => (
          <Menu.Item
            key={label}
            rightSection={<Kbd size="xs">{key}</Kbd>}
            onClick={run((clipId) => editor.dispatch({ type: 'nudge', clipId, frames: Number(frames) }))}
          >
            {label}
          </Menu.Item>
        ))}
        <Menu.Label>Gain {gain === null ? '(silent)' : `(${gain > 0 ? '+' : ''}${gain} dB)`}</Menu.Label>
        <Menu.Item
          disabled={gain !== null && gain >= GAIN_DB_RANGE[1]}
          onClick={run((clipId) =>
            editor.dispatch({ type: 'setGain', clipId, gainDb: (gain ?? GAIN_DB_RANGE[0]) + 1 }),
          )}
        >
          Louder (+1 dB)
        </Menu.Item>
        <Menu.Item
          disabled={gain === null}
          onClick={run((clipId) => editor.dispatch({ type: 'setGain', clipId, gainDb: (gain ?? 0) - 1 }))}
        >
          Quieter (−1 dB)
        </Menu.Item>
        <Menu.Item
          disabled={gain === 0}
          onClick={run((clipId) => editor.dispatch({ type: 'setGain', clipId, gainDb: 0 }))}
        >
          Reset gain (0 dB)
        </Menu.Item>
        <Menu.Item
          onClick={run((clipId) =>
            editor.dispatch({ type: 'setGain', clipId, gainDb: gain === null ? 0 : null }),
          )}
        >
          {gain === null ? 'Unsilence' : 'Silence'}
        </Menu.Item>
        <Menu.Label>Fades</Menu.Label>
        <Menu.Item
          disabled={!fade}
          onClick={run((clipId) => editor.dispatch({ type: 'setFades', clipId, fadeInSamples: fade }))}
        >
          Fade in {fade / SAMPLE_RATE} s
        </Menu.Item>
        <Menu.Item
          disabled={!fade}
          onClick={run((clipId) => editor.dispatch({ type: 'setFades', clipId, fadeOutSamples: fade }))}
        >
          Fade out {fade / SAMPLE_RATE} s
        </Menu.Item>
        <Menu.Item
          disabled={!clip || (clip.fadeInSamples === 0 && clip.fadeOutSamples === 0)}
          onClick={run((clipId) =>
            editor.dispatch({ type: 'setFades', clipId, fadeInSamples: 0, fadeOutSamples: 0 }),
          )}
        >
          Remove fades
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          color="red"
          rightSection={<Kbd size="xs">Del</Kbd>}
          onClick={run((clipId) => editor.dispatch({ type: 'delete', clipId }))}
        >
          Delete
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  )
}

const seconds = (samples: number) => Math.round((samples / SAMPLE_RATE) * 100) / 100

/**
 * The selected clip's gain and fades as number fields, with undo/redo buttons. Typing is one gesture per field (a
 * single undo entry, closed when the field loses focus); editing shortcuts stand aside while a field has focus.
 */
export function ClipInspector({
  editor,
  start,
  end,
}: {
  editor: NarrationEditor
  start?: ReactNode
  /** At the right of the row for the selected clip (its take's Download). */
  end?: (clip: NarrationClip) => ReactNode
}) {
  const clip = editor.selected ? editor.op.clips.find((c) => c.id === editor.selected) : undefined
  const max = clip ? seconds(maxFade(clipLength(clip))) : 0
  return (
    <Group gap="sm" align="end" wrap="wrap" data-testid="clip-inspector">
      {start}
      <Button size="xs" variant="default" disabled={!editor.canUndo} onClick={editor.undo}>
        Undo
      </Button>
      <Button size="xs" variant="default" disabled={!editor.canRedo} onClick={editor.redo}>
        Redo
      </Button>
      {clip ? (
        <>
          <NumberInput
            size="xs"
            w={110}
            label="Gain (dB)"
            min={GAIN_DB_RANGE[0]}
            max={GAIN_DB_RANGE[1]}
            step={0.5}
            value={clip.gainDb ?? ''}
            placeholder="Silent"
            onChange={(v) => {
              if (typeof v === 'number')
                editor.dispatch(
                  { type: 'setGain', clipId: clip.id, gainDb: v },
                  { coalesce: `gain:${clip.id}` },
                )
            }}
            onBlur={editor.commit}
          />
          <NumberInput
            size="xs"
            w={110}
            label="Fade in (s)"
            min={0}
            max={max}
            step={0.1}
            decimalScale={2}
            value={seconds(clip.fadeInSamples)}
            onChange={(v) => {
              if (typeof v === 'number')
                editor.dispatch(
                  { type: 'setFades', clipId: clip.id, fadeInSamples: Math.round(v * SAMPLE_RATE) },
                  { coalesce: `fadeIn:${clip.id}` },
                )
            }}
            onBlur={editor.commit}
          />
          <NumberInput
            size="xs"
            w={110}
            label="Fade out (s)"
            min={0}
            max={max}
            step={0.1}
            decimalScale={2}
            value={seconds(clip.fadeOutSamples)}
            onChange={(v) => {
              if (typeof v === 'number')
                editor.dispatch(
                  { type: 'setFades', clipId: clip.id, fadeOutSamples: Math.round(v * SAMPLE_RATE) },
                  { coalesce: `fadeOut:${clip.id}` },
                )
            }}
            onBlur={editor.commit}
          />
          <Text size="xs" c="var(--va-muted)" className="num" data-testid="clip-inspector-span">
            {clip.id}: {seconds(clip.start).toFixed(2)}–{seconds(clipEnd(clip)).toFixed(2)} s
          </Text>
          {end ? <div style={{ marginLeft: 'auto' }}>{end(clip)}</div> : null}
        </>
      ) : (
        <Text size="xs" c="var(--va-muted)">
          Select a clip to edit it.
        </Text>
      )}
    </Group>
  )
}

/** Announces the editor's last action to screen readers. */
export function EditorAnnouncer({ editor }: { editor: NarrationEditor }) {
  // A trailing no-break space on alternate announcements makes a repeated message ("Split", "Split") re-announce.
  const { text, n } = editor.announcement
  return (
    <div className="va-tl-sr" aria-live="polite" role="status" data-testid="timeline-announcer">
      {text ? `${text}${n % 2 ? '' : ' '}` : ''}
    </div>
  )
}
