// A recording scene in the editor (screen-recording plan §8.2; va-rsk5.4.4, 4.5): Trim (the span and the speed it
// gives), Camera (the zoom box at a moment, keys, Auto, No zoom), Cursor (style and size), Hide (the locked areas with
// why, the scene's own: keep or remove, blur or solid, draw more; the person's setup boxes can be shortened). Every
// change is the scene's recording (or the composition's setupBoxes) in the editor's composition; the page turns it into
// span, camera, cursor, redact and boxSpan ops (lib/recording-edit.ts) and the server checks each.
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  NumberInput,
  RangeSlider,
  SegmentedControl,
  Slider,
  Stack,
  Tabs,
  Text,
} from '@mantine/core'
import { IconLock, IconTrash } from '@tabler/icons-react'
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { paths } from '../../api/schema'
import type { SetupBox } from '../../lib/demo-setup'
import {
  autoCamera,
  cameraNow,
  newArea,
  noZoom,
  sceneAreas,
  setCameraKey,
  speedNote,
  speedOf,
  type RecordingBeat,
  type SceneArea,
} from '../../lib/recording-edit'
import { BoxCanvas, croppedVideoStyle } from './DemoSetup'

type Edit = paths['/api/v1/edits/{id}']['get']['responses'][200]['content']['application/json']
export type EditRecording = NonNullable<Edit['recording']>

const fmt = (s: number) => `${String(Math.floor(s / 60))}:${(s % 60).toFixed(1).padStart(4, '0')}`
type Locked = { id: string; origin: string; start: number; end: number; reason: string; style?: string }

/** Why a locked area is hidden, as the Hidden list says it. */
const lockedWhy = (e: Locked) =>
  e.origin === 'setup'
    ? 'You drew it'
    : e.reason === 'password field'
      ? 'Password field'
      : e.reason === 'hidden text'
        ? 'Text you asked to hide'
        : /^privacy mode/i.test(e.reason)
          ? e.reason
          : 'Marked hidden when recorded'

/** The recording at a moment, with the camera's zoom box over it: drag to move, the zoom field to resize. */
function CameraFrame(props: {
  src: string | undefined
  rec: RecordingBeat
  t: number
  aspect: number
  onMove: (x: number, y: number) => void
}) {
  const area = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const drag = useRef<{ x0: number; y0: number; cx: number; cy: number } | null>(null)
  // A cropped demo: the picture is the crop, as the scene draws it.
  const crop = props.rec.crop ?? null
  const [x, y, z] = cameraNow(props.rec.camera, props.t)
  if (video.current && Math.abs(video.current.currentTime - props.t) > 0.05)
    video.current.currentTime = props.t
  const at = (e: ReactPointerEvent) => {
    const r = area.current?.getBoundingClientRect()
    return r ? { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } : { x: 0, y: 0 }
  }
  return (
    <div
      ref={area}
      data-testid="camera-frame"
      style={{
        position: 'relative',
        aspectRatio: crop ? `${String(crop.width)} / ${String(crop.height)}` : String(props.aspect),
        background: '#000',
        borderRadius: 8,
        overflow: 'hidden',
        touchAction: 'none',
      }}
    >
      <video
        ref={video}
        src={props.src}
        muted
        playsInline
        preload="auto"
        style={crop ? croppedVideoStyle(crop) : { width: '100%', height: '100%', display: 'block' }}
      />
      <div
        role="button"
        tabIndex={0}
        aria-label="Camera box"
        data-testid="camera-box"
        onPointerDown={(e) => {
          const p = at(e)
          drag.current = { x0: p.x, y0: p.y, cx: x, cy: y }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const p = at(e)
          props.onMove(d.cx + p.x - d.x0, d.cy + p.y - d.y0)
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        style={{
          position: 'absolute',
          left: `${String((x - 0.5 / z) * 100)}%`,
          top: `${String((y - 0.5 / z) * 100)}%`,
          width: `${String(100 / z)}%`,
          height: `${String(100 / z)}%`,
          outline: '2px solid var(--mantine-color-blue-4)',
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
          cursor: 'move',
        }}
      />
    </div>
  )
}

export function RecordingPanel(props: {
  beatId: string
  sceneSec: number
  rec: RecordingBeat
  info: EditRecording
  /** The recording file's URL (through the version's preview link), when it's known. */
  src: string | undefined
  /** The frame's width over height. */
  aspect: number
  readOnly?: boolean
  onChange: (next: RecordingBeat) => void
  /** When each of the person's setup boxes hides (the composition's setupBoxes); they can shorten it here. */
  setupBoxes?: { id: string; start: number; end: number }[] | undefined
  onSetupBoxes?: (next: { id: string; start: number; end: number }[]) => void
}) {
  const { rec, info } = props
  const ro = props.readOnly === true
  const [t, setT] = useState(rec.in)
  const now = Math.min(rec.out, Math.max(rec.in, t))
  const speed = speedOf(rec, props.sceneSec)
  const note = speedNote(speed)
  const [, , zoomNow] = cameraNow(rec.camera, now)
  const areas = sceneAreas(rec)
  const locked = (info.locked as Locked[]).filter((e) => e.start < rec.out && e.end > rec.in)
  const set = (patch: Partial<RecordingBeat>) => {
    props.onChange({ ...rec, ...patch })
  }
  const setAreas = (next: SceneArea[]) => {
    set({ redact: next })
  }
  // The editor's own boxes as the canvas draws them (at the moment shown); locked ones aren't drawn here.
  const canvasBoxes: SetupBox[] = areas.map((a) => {
    const k = a.boxes.filter((b) => b[0] <= now + 1e-6).at(-1) ?? a.boxes[0] ?? [a.start, 0, 0, 0, 0]
    return {
      id: a.id,
      x: k[1],
      y: k[2],
      w: k[3],
      h: k[4],
      start: a.start,
      end: a.end,
      ...(a.style ? { style: a.style } : {}),
    }
  })
  // A box being drawn stays here until it's big enough to be a hidden area (the patcher refuses an empty one).
  const [drawing, setDrawing] = useState<SetupBox | null>(null)
  const nextId = () => {
    let n = 1
    while (areas.some((a) => a.id === `e${String(n)}`)) n++
    return `e${String(n)}`
  }
  const fromCanvas = (boxes: SetupBox[]) => {
    const next: SceneArea[] = []
    let pending: SetupBox | null = null
    for (const b of boxes) {
      const was = areas.find((a) => a.id === b.id)
      const box: [number, number, number, number] = [b.x, b.y, b.w, b.h]
      if (was)
        next.push({
          ...was,
          boxes: was.boxes.length === 1 ? [[was.boxes[0]?.[0] ?? was.start, ...box]] : was.boxes,
        })
      else if (b.w >= 0.01 && b.h >= 0.01) next.push({ ...newArea(areas, rec, box), id: b.id })
      else pending = b
    }
    setDrawing(pending)
    if (JSON.stringify(next) !== JSON.stringify(areas)) setAreas(next)
  }
  const [selected, setSelected] = useState<string | null>(null)

  return (
    <Tabs defaultValue="trim" keepMounted={false} data-testid={`recording-panel-${props.beatId}`}>
      <Tabs.List>
        <Tabs.Tab value="trim">Trim</Tabs.Tab>
        <Tabs.Tab value="camera">Camera</Tabs.Tab>
        <Tabs.Tab value="cursor">Cursor</Tabs.Tab>
        <Tabs.Tab value="hide">Hide</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="trim" pt="sm">
        <Stack gap="xs">
          <Group justify="space-between">
            <Text size="sm">
              Shows {fmt(rec.in)} – {fmt(rec.out)} of the recording
            </Text>
            <Badge
              data-testid="trim-speed"
              color={note.tone === 'bad' ? 'red' : note.tone === 'warn' ? 'yellow' : 'gray'}
              variant="light"
            >
              {note.text}
            </Badge>
          </Group>
          <RangeSlider
            aria-label="Span"
            thumbFromLabel="In"
            thumbToLabel="Out"
            min={0}
            max={info.duration}
            step={0.05}
            minRange={0.5}
            value={[rec.in, rec.out]}
            label={(v) => fmt(v)}
            disabled={ro}
            onChange={([a, b]) => {
              set({ in: Math.round(a * 1000) / 1000, out: Math.round(b * 1000) / 1000 })
            }}
          />
          <Text size="xs" c="var(--va-muted)">
            The scene keeps its length; the speed follows. Camera keys and clicks outside the span are
            dropped.
          </Text>
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="camera" pt="sm">
        <Stack gap="xs">
          <CameraFrame
            src={props.src}
            rec={rec}
            t={now}
            aspect={props.aspect}
            onMove={(x, y) => {
              if (!ro) set({ camera: setCameraKey(rec.camera, now, x, y, zoomNow) })
            }}
          />
          <Slider
            aria-label="Moment"
            min={rec.in}
            max={rec.out}
            step={1 / 30}
            value={now}
            label={(v) => fmt(v)}
            onChange={setT}
          />
          <Group gap="xs" align="end">
            <NumberInput
              label="Zoom"
              size="xs"
              w={110}
              min={1}
              max={info.zoomMax}
              step={0.1}
              decimalScale={2}
              value={Math.round(zoomNow * 100) / 100}
              disabled={ro}
              onChange={(v) => {
                const [x, y] = cameraNow(rec.camera, now)
                set({ camera: setCameraKey(rec.camera, now, x, y, Math.min(info.zoomMax, Number(v) || 1)) })
              }}
            />
            <Button
              size="xs"
              variant="default"
              disabled={ro}
              onClick={() => set({ camera: autoCamera(info.camera[rec.step], rec) })}
            >
              Auto
            </Button>
            <Button size="xs" variant="default" disabled={ro} onClick={() => set({ camera: noZoom(rec) })}>
              No zoom
            </Button>
          </Group>
          <Stack gap={4} data-testid="camera-keys">
            {(rec.camera as (number | string)[][]).map((k, i) => (
              <Group key={`${String(k[0])}-${String(i)}`} gap="xs" wrap="nowrap">
                <Text size="xs" className="num" w={60}>
                  {fmt(Number(k[0]))}
                </Text>
                <Text size="xs" className="num">
                  zoom {Number(k[3]).toFixed(2)}
                </Text>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label={`Delete camera key at ${fmt(Number(k[0]))}`}
                  disabled={ro || rec.camera.length < 2}
                  onClick={() => set({ camera: rec.camera.filter((_, j) => j !== i) })}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="cursor" pt="sm">
        <Stack gap="xs">
          <SegmentedControl
            aria-label="Cursor"
            value={rec.cursor.style}
            disabled={ro}
            onChange={(v) => set({ cursor: { ...rec.cursor, style: v } })}
            data={[
              { value: 'smooth', label: 'Smooth', disabled: !info.trace },
              { value: 'highlight', label: 'Highlight' },
              { value: 'none', label: 'None' },
            ]}
          />
          {!info.trace ? (
            <Text size="xs" c="var(--va-muted)">
              A smooth cursor needs cursor data (a recording made with video-agent record).
            </Text>
          ) : null}
          <Text size="sm">Size</Text>
          <Slider
            aria-label="Cursor size"
            min={0.5}
            max={2}
            step={0.1}
            value={rec.cursor.size ?? 1}
            disabled={ro || rec.cursor.style === 'none'}
            onChange={(v) => set({ cursor: { ...rec.cursor, size: v } })}
          />
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="hide" pt="sm">
        <Stack gap="xs">
          {locked.map((e) => {
            // The person's own box: its span can change (where it is and how it looks can't).
            const span = e.origin === 'setup' ? props.setupBoxes?.find((x) => x.id === e.id) : undefined
            const setSpan = (start: number, end: number) => {
              props.onSetupBoxes?.(
                (props.setupBoxes ?? []).map((x) => (x.id === e.id ? { ...x, start, end } : x)),
              )
            }
            return (
              <Stack key={e.id} gap={4} data-testid="locked-area">
                <Group gap="xs" wrap="nowrap">
                  <IconLock size={14} aria-label="Locked" />
                  <Text size="sm">{lockedWhy(e)}</Text>
                  <Text size="xs" c="var(--va-muted)" className="num">
                    {fmt(span?.start ?? e.start)} – {fmt(span?.end ?? e.end)} ·{' '}
                    {e.style === 'solid' ? 'solid' : 'blurred'}
                  </Text>
                </Group>
                {span && props.onSetupBoxes ? (
                  <Group gap="xs" wrap="nowrap" pl={22} data-testid="setup-span">
                    <NumberInput
                      size="xs"
                      w={96}
                      label="From (s)"
                      aria-label={`${e.id} from`}
                      min={0}
                      max={span.end - 0.1}
                      step={0.5}
                      decimalScale={1}
                      value={span.start}
                      disabled={ro}
                      onChange={(v) => {
                        const n = typeof v === 'number' ? v : Number(v)
                        if (Number.isFinite(n) && n >= 0 && n < span.end) setSpan(n, span.end)
                      }}
                    />
                    <NumberInput
                      size="xs"
                      w={96}
                      label="To (s)"
                      aria-label={`${e.id} to`}
                      min={span.start + 0.1}
                      max={info.duration}
                      step={0.5}
                      decimalScale={1}
                      value={span.end}
                      disabled={ro}
                      onChange={(v) => {
                        const n = typeof v === 'number' ? v : Number(v)
                        if (Number.isFinite(n) && n > span.start && n <= info.duration + 0.5)
                          setSpan(span.start, n)
                      }}
                    />
                    <Button
                      size="xs"
                      variant="subtle"
                      mt={18}
                      disabled={ro || (span.start === 0 && span.end >= info.duration)}
                      onClick={() => setSpan(0, info.duration)}
                    >
                      Whole recording
                    </Button>
                  </Group>
                ) : null}
              </Stack>
            )
          })}
          {areas.map((a) => (
            <Group key={a.id} gap="xs" wrap="nowrap" data-testid="scene-area">
              <Text size="sm" style={{ flex: 1 }}>
                {a.origin === 'editor'
                  ? 'You drew it in the editor'
                  : /^privacy mode/i.test(a.reason)
                    ? `Proposed: ${a.reason}`
                    : `Added by the agent${a.reason ? `: ${a.reason}` : ''}`}
              </Text>
              <SegmentedControl
                size="xs"
                aria-label={`${a.id} style`}
                value={a.style === 'solid' ? 'solid' : 'blur'}
                disabled={ro}
                onChange={(v) => {
                  setAreas(
                    areas.map((x) => {
                      if (x.id !== a.id) return x
                      const rest = { ...x }
                      delete rest.style
                      return v === 'solid' ? { ...rest, style: 'solid' } : rest
                    }),
                  )
                }}
                data={[
                  { value: 'blur', label: 'Blur' },
                  { value: 'solid', label: 'Solid' },
                ]}
              />
              <Button
                size="xs"
                variant="subtle"
                color="red"
                aria-label={`Remove ${a.id}`}
                disabled={ro}
                onClick={() => setAreas(areas.filter((x) => x.id !== a.id))}
              >
                Remove
              </Button>
            </Group>
          ))}
          {!locked.length && !areas.length ? (
            <Text size="sm" c="var(--va-muted)">
              Nothing is hidden in this scene.
            </Text>
          ) : null}
          <Text size="xs" c="var(--va-muted)">
            Draw a box on the picture to hide more (for the whole scene, blurred). Locked areas, from your
            setup and the recording, can&apos;t be removed; your own boxes can be shortened.
          </Text>
          {ro ? null : (
            <BoxCanvas
              media={{
                width: props.aspect * 1000,
                height: 1000,
                durationSec: info.duration,
                src: props.src,
                poster: null,
              }}
              crop={rec.crop}
              boxes={drawing ? [...canvasBoxes, drawing] : canvasBoxes}
              newId={nextId}
              selected={selected}
              onSelect={setSelected}
              onChange={fromCanvas}
              videoRef={{ current: null }}
            />
          )}
        </Stack>
      </Tabs.Panel>
    </Tabs>
  )
}
