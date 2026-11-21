// Demo setup (screen-recording plan §4.4; va-rsk5.4.2): where privacy is set. Play the recording; trim the ends; crop
// the picture; draw boxes over anything private (each hides its area for a span, the whole recording by default); two
// plain notes about who sees what and what the AI looks at; a note on the cursor; then the usual fields and "Make
// it", which creates the demo with recording { mediaId, trim, crop, redact }. The demo starts private when anything
// is hidden.
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  RangeSlider,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconCrop, IconEyeOff, IconInfoCircle, IconTrash } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { $api, errorMessage, newIdempotencyKey } from '../../api/client'
import type { paths } from '../../api/schema'
import { sharpZoomMax, ZOOM_MIN } from '../../../../server/lib/recording'
import type { RecordingCrop } from '../../../../server/lib/recording-crop'
import {
  cropMin,
  defaultLength,
  fitBox,
  isWhole,
  MIN_TRIM,
  recordingInput,
  WHOLE,
  type CropBox,
  type SetupBox,
} from '../../lib/demo-setup'
import { CropOverlay } from './CropOverlay'
import { RecordingPlayer } from './RecordingPlayer'
import { defaultLook, looksForDemo } from '../../lib/looks'
import { LookControl, useLooks } from '../LookPicker'
import { SoundControl, type Sound } from '../SoundControl'
import { VOICE_OFF, VoiceoverControl, voiceInput, type VoiceState } from '../VoiceoverControl'

type Media = paths['/api/v1/media/{id}']['get']['responses'][200]['content']['application/json']

const SHAPES = [
  { value: '16:9', label: 'Landscape' },
  { value: '9:16', label: 'Vertical' },
  { value: '1:1', label: 'Square' },
  { value: '4:5', label: 'Portrait' },
] as const
type Shape = (typeof SHAPES)[number]['value']

const fmt = (s: number) => `${String(Math.floor(s / 60))}:${(s % 60).toFixed(1).padStart(4, '0')}`
let boxSeq = 0

/**
 * How a <video> is placed in a box of the crop's shape so that only the crop shows (the box clips the rest), as
 * va-recording.js draws a cropped scene.
 */
export function croppedVideoStyle(c: RecordingCrop): React.CSSProperties {
  return {
    position: 'absolute',
    left: `${String((-c.x / c.width) * 100)}%`,
    top: `${String((-c.y / c.height) * 100)}%`,
    width: `${String((c.frameWidth / c.width) * 100)}%`,
    height: `${String((c.frameHeight / c.height) * 100)}%`,
    maxWidth: 'none',
    objectFit: 'fill',
  }
}

/** The player and the box tool: draw on the picture to add a box, drag one to move it (setup and the editor). */
export function BoxCanvas(props: {
  media: {
    width: number | null
    height: number | null
    durationSec: number | null
    src?: string | undefined
    poster?: string | null
  }
  boxes: SetupBox[]
  selected: string | null
  onSelect: (id: string | null) => void
  onChange: (boxes: SetupBox[]) => void
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** The id a newly drawn box gets (the editor's eN); setup numbers its own. */
  newId?: () => string
  /** The recording's own sound plays (setup's player); muted otherwise. */
  sound?: boolean
  /** A cropped demo (the editor): the picture is the crop, and boxes are fractions of it. */
  crop?: RecordingCrop | null | undefined
  /** Drawn over the picture and the boxes (setup's crop rectangle). */
  overlay?: ReactNode
}) {
  const area = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: 'draw' | 'move'; id: string; x0: number; y0: number; box: SetupBox } | null>(
    null,
  )
  const duration = props.media.durationSec ?? 0
  const at = (e: ReactPointerEvent) => {
    const r = area.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }
  const update = (b: SetupBox) => {
    props.onChange(props.boxes.map((x) => (x.id === b.id ? b : x)))
  }
  return (
    <div
      ref={area}
      data-testid="box-canvas"
      style={{
        position: 'relative',
        aspectRatio: props.crop
          ? `${String(props.crop.width)} / ${String(props.crop.height)}`
          : `${String(props.media.width ?? 16)} / ${String(props.media.height ?? 9)}`,
        background: '#000',
        borderRadius: 8,
        overflow: 'hidden',
        touchAction: 'none',
        cursor: 'crosshair',
      }}
      onPointerDown={(e) => {
        const p = at(e)
        const id = props.newId ? props.newId() : `box${String(++boxSeq)}`
        const box: SetupBox = { id, x: p.x, y: p.y, w: 0, h: 0, start: 0, end: duration }
        drag.current = { mode: 'draw', id, x0: p.x, y0: p.y, box }
        props.onChange([...props.boxes, box])
        props.onSelect(id)
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const p = at(e)
        if (d.mode === 'draw')
          update({
            ...d.box,
            x: Math.min(d.x0, p.x),
            y: Math.min(d.y0, p.y),
            w: Math.abs(p.x - d.x0),
            h: Math.abs(p.y - d.y0),
          })
        else update(fitBox({ ...d.box, x: d.box.x + p.x - d.x0, y: d.box.y + p.y - d.y0 }))
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        if (d?.mode !== 'draw') return
        // A click without a drag adds nothing.
        const b = props.boxes.find((x) => x.id === d.id)
        if (!b || b.w < 0.01 || b.h < 0.01) {
          props.onChange(props.boxes.filter((x) => x.id !== d.id))
          props.onSelect(null)
        } else update(fitBox(b))
      }}
    >
      <video
        ref={props.videoRef}
        src={props.media.src}
        poster={props.media.poster ?? undefined}
        muted={!props.sound}
        playsInline
        preload="metadata"
        style={{
          ...(props.crop
            ? croppedVideoStyle(props.crop)
            : { width: '100%', height: '100%', display: 'block' }),
          pointerEvents: 'none',
        }}
      />
      {props.boxes.map((b, i) => (
        <div
          key={b.id}
          role="button"
          tabIndex={0}
          aria-label={`Hidden area ${String(i + 1)}`}
          data-testid="hidden-box"
          onPointerDown={(e) => {
            e.stopPropagation()
            const p = at(e)
            drag.current = { mode: 'move', id: b.id, x0: p.x, y0: p.y, box: b }
            props.onSelect(b.id)
            area.current?.setPointerCapture(e.pointerId)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Delete' || e.key === 'Backspace')
              props.onChange(props.boxes.filter((x) => x.id !== b.id))
          }}
          style={{
            position: 'absolute',
            left: `${String(b.x * 100)}%`,
            top: `${String(b.y * 100)}%`,
            width: `${String(b.w * 100)}%`,
            height: `${String(b.h * 100)}%`,
            // As the render draws it: the picture blurred and darkened under the box, or a flat box.
            ...(b.style === 'solid'
              ? { background: 'var(--mantine-color-gray-5)' }
              : {
                  backdropFilter: 'blur(8px) brightness(0.82)',
                  WebkitBackdropFilter: 'blur(8px) brightness(0.82)',
                  background: 'rgba(0,0,0,0.06)',
                }),
            outline: props.selected === b.id ? '2px solid var(--mantine-color-blue-5)' : '1px solid #fff',
            cursor: 'move',
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            fontSize: 12,
          }}
        ></div>
      ))}
      {props.overlay}
    </div>
  )
}

export function DemoSetup(props: { media: Media; onBack: () => void }) {
  const { media } = props
  const duration = media.durationSec ?? 0
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [key] = useState(newIdempotencyKey)
  const video = useRef<HTMLVideoElement | null>(null)
  const [trim, setTrim] = useState<[number, number]>([0, duration])
  const [boxes, setBoxes] = useState<SetupBox[]>([])
  const [crop, setCrop] = useState<CropBox>(WHOLE)
  const [cropping, setCropping] = useState(false)
  const cropped = !isWhole(crop)
  // What's kept, in the recording's pixels.
  const kept =
    media.width !== null && media.height !== null
      ? { width: Math.round(crop[2] * media.width), height: Math.round(crop[3] * media.height) }
      : null
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [length, setLength] = useState<number | string>(defaultLength(duration))
  const [lengthTouched, setLengthTouched] = useState(false)
  const [shape, setShape] = useState<Shape>('16:9')
  const [sound, setSound] = useState<Sound>('silent')
  const [voice, setVoice] = useState<VoiceState>(VOICE_OFF)
  const [look, setLook] = useState<string | null | undefined>(undefined)
  // The admin default only when a demo can use it (HyperFrames, recordings shown); else None, sent as null so the
  // server doesn't apply it either.
  const looks = useLooks()
  const def = defaultLook(looks)
  const unusableDefault = !!def && !looksForDemo(looks?.looks ?? []).some((l) => l.id === def.id)
  const chosenLook = look === undefined && unusableDefault ? null : look
  const [quick, setQuick] = useState(false)
  const [privacy, setPrivacy] = useState(false)
  const [hideText, setHideText] = useState('')
  const hideStrings = [
    ...new Set(
      hideText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length >= 2),
    ),
  ].slice(0, 50)

  const create = $api.useMutation('post', '/api/v1/videos', {
    onSuccess: (v) => {
      void qc.invalidateQueries()
      void navigate(`/videos/${v.id}`)
    },
    onError: (e) =>
      notifications.show({ color: 'red', title: "Couldn't start the demo", message: errorMessage(e) }),
  })

  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t
  }
  // Too small to zoom in sharply in this shape (the planner holds the camera back; app/server/lib/recording.ts).
  const small = kept !== null && kept.width > 0 && sharpZoomMax(kept, shape, 'wallpaper') < ZOOM_MIN
  const valid = prompt.trim().length >= 10 && Number(length) >= 3
  const submit = () => {
    const recording = recordingInput({ mediaId: media.id, duration, trim, boxes, crop })
    const body = {
      prompt: prompt.trim(),
      aspect: shape,
      durationSec: Number(length),
      sound,
      recording: {
        ...recording,
        ...(privacy ? { privacy: true } : {}),
        ...(hideStrings.length ? { hideStrings } : {}),
      },
      ...(quick ? { agent: false } : voice.enabled ? { voiceover: voiceInput(voice) } : {}),
      ...(chosenLook !== undefined ? { look: chosenLook } : {}),
    }
    create.mutate({ body, params: { header: { 'idempotency-key': key } } })
  }

  return (
    <Stack gap="lg" data-testid="demo-setup">
      <Card withBorder radius="lg" p="lg">
        <Stack gap="sm">
          <BoxCanvas
            media={{ ...media, src: media.urls?.original, poster: media.urls?.poster ?? null }}
            boxes={boxes}
            selected={selected}
            onSelect={setSelected}
            onChange={setBoxes}
            videoRef={video}
            sound
            overlay={<CropOverlay value={crop} active={cropping} min={cropMin(media)} onChange={setCrop} />}
          />
          <RecordingPlayer video={video} trim={trim} />
          <div>
            <Group justify="space-between">
              <Text size="sm" fw={500}>
                Trim the ends
              </Text>
              <Text size="xs" c="var(--va-muted)" className="num" data-testid="trim-label">
                {fmt(trim[0])} – {fmt(trim[1])} ({(trim[1] - trim[0]).toFixed(1)} s used)
              </Text>
            </Group>
            <RangeSlider
              aria-label="Trim"
              thumbFromLabel="Start"
              thumbToLabel="End"
              min={0}
              max={duration}
              step={0.1}
              minRange={MIN_TRIM}
              value={trim}
              label={(v) => fmt(v)}
              onChange={(v) => {
                if (v[0] !== trim[0]) seek(v[0])
                else if (v[1] !== trim[1]) seek(v[1])
                setTrim(v)
                if (!lengthTouched) setLength(defaultLength(v[1] - v[0]))
              }}
            />
          </div>
          <div>
            <Group justify="space-between" align="center" wrap="nowrap">
              <Text size="sm" fw={500}>
                Crop the picture
              </Text>
              <Group gap="xs" wrap="nowrap">
                {cropped ? (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => {
                      setCrop(WHOLE)
                      setCropping(false)
                    }}
                  >
                    Reset
                  </Button>
                ) : null}
                <Button
                  size="compact-xs"
                  variant={cropping ? 'filled' : 'light'}
                  leftSection={<IconCrop size={14} />}
                  aria-pressed={cropping}
                  onClick={() => {
                    setCropping(!cropping)
                    setSelected(null)
                  }}
                >
                  {cropping ? 'Done' : cropped ? 'Change crop' : 'Crop'}
                </Button>
              </Group>
            </Group>
            <Text size="xs" c="var(--va-muted)" data-testid="crop-note">
              {cropping
                ? 'Drag the corners and edges, or draw a new rectangle on the picture. Then choose Done.'
                : cropped && kept
                  ? `The demo uses ${String(kept.width)}×${String(kept.height)} px of the ${String(media.width)}×${String(media.height)} picture; the dimmed part is left out.`
                  : 'Keep only part of the picture: the browser without the menu bar and the dock, say. Zooms and the cursor follow the part you keep.'}
            </Text>
          </div>
          <div>
            <Text size="sm" fw={500}>
              Hide something
            </Text>
            <Text size="xs" c="var(--va-muted)">
              Draw a box on the picture over anything private: an email, a key, a customer's name. It's
              blurred in the video (or a solid box, if you choose). Drag a box to move it.
            </Text>
          </div>
          {boxes.length ? (
            <Stack gap={6} data-testid="box-list">
              {boxes.map((b, i) => (
                <Group key={b.id} gap="xs" wrap="nowrap">
                  <Text size="sm" w={70}>
                    Area {i + 1}
                  </Text>
                  <NumberInput
                    aria-label={`Area ${String(i + 1)} from`}
                    size="xs"
                    w={96}
                    min={0}
                    max={duration}
                    step={0.5}
                    decimalScale={1}
                    suffix=" s"
                    value={b.start}
                    onChange={(v) => {
                      setBoxes(boxes.map((x) => (x.id === b.id ? { ...x, start: Number(v) || 0 } : x)))
                    }}
                  />
                  <Text size="xs">to</Text>
                  <NumberInput
                    aria-label={`Area ${String(i + 1)} to`}
                    size="xs"
                    w={96}
                    min={0}
                    max={duration}
                    step={0.5}
                    decimalScale={1}
                    suffix=" s"
                    value={b.end}
                    onChange={(v) => {
                      setBoxes(boxes.map((x) => (x.id === b.id ? { ...x, end: Number(v) || 0 } : x)))
                    }}
                  />
                  <SegmentedControl
                    size="xs"
                    aria-label={`Area ${String(i + 1)} style`}
                    value={b.style ?? 'blur'}
                    onChange={(v) => {
                      setBoxes(
                        boxes.map((x) =>
                          x.id === b.id ? { ...x, style: v === 'solid' ? 'solid' : 'blur' } : x,
                        ),
                      )
                    }}
                    data={[
                      { value: 'blur', label: 'Blur' },
                      { value: 'solid', label: 'Solid' },
                    ]}
                  />
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Delete area ${String(i + 1)}`}
                    onClick={() => {
                      setBoxes(boxes.filter((x) => x.id !== b.id))
                    }}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              ))}
            </Stack>
          ) : null}
          {small ? (
            <Alert variant="light" color="yellow" data-testid="low-res-note">
              <Text size="sm">
                {cropped
                  ? `The part you keep is ${String(kept.width)}×${String(kept.height)}`
                  : `This recording is ${String(media.width)}×${String(media.height)}`}
                , small for a {shape} video, so Video Agent will zoom in only a little to keep it sharp. For
                sharp zooms, record at 2x or in a larger window.
              </Text>
            </Alert>
          ) : null}
          <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} data-testid="setup-notes">
            <Stack gap={4}>
              <Text size="sm" data-testid="cursor-note">
                {media.hasTrace
                  ? 'Smooth cursor from your cursor data.'
                  : 'Video Agent will look for your cursor in the picture.'}
              </Text>
              <Text size="sm">
                People who can open this video can also watch the full recording, including the parts that get
                cut and hidden.
              </Text>
              <Text size="sm">Video Agent's AI looks at frames from your recording.</Text>
            </Stack>
          </Alert>
        </Stack>
      </Card>

      <Stack gap="md">
        <Textarea
          label="What should the demo show?"
          description="The story, the audience, any words to put on screen."
          placeholder="A 45-second demo of adding a webhook: open Settings, add the URL, send a test event."
          autosize
          minRows={3}
          maxLength={4000}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.currentTarget.value)
          }}
        />
        <Group align="end" gap="md">
          <NumberInput
            label="Length"
            description="About 0.4 of what's used"
            min={3}
            max={300}
            suffix=" s"
            w={160}
            value={length}
            onChange={(v) => {
              setLength(v)
              setLengthTouched(true)
            }}
          />
          <div>
            <Text size="sm" fw={500} mb={8}>
              Shape
            </Text>
            <SegmentedControl
              value={shape}
              onChange={(v) => {
                setShape(v)
              }}
              data={SHAPES.map((s) => ({ value: s.value, label: s.label }))}
            />
          </div>
        </Group>
        <SoundControl value={sound} media={[]} onChange={setSound} />
        {quick ? null : <VoiceoverControl value={voice} onChange={setVoice} />}
        <LookControl value={chosenLook} onChange={setLook} only={looksForDemo} />
        <Checkbox
          label="Quick demo"
          description="A scene per step with a stock intro and outro, made without the agent writing it. No voice-over."
          checked={quick}
          onChange={(e) => {
            setQuick(e.currentTarget.checked)
          }}
        />
        <Checkbox
          label="Privacy mode"
          description="Off: only the areas you draw (and password fields) are hidden; names and URLs stay visible. On: Video Agent also finds emails, keys, tokens, URLs and names on screen and hides them for you to keep or remove."
          checked={privacy}
          onChange={(e) => {
            setPrivacy(e.currentTarget.checked)
          }}
        />
        <Textarea
          label="Hide these words"
          description="One per line: a customer's name, a project id. Hidden wherever they show, privacy mode or not."
          autosize
          minRows={2}
          maxLength={10_000}
          value={hideText}
          onChange={(e) => {
            setHideText(e.currentTarget.value)
          }}
        />
        {boxes.length || privacy || hideStrings.length ? (
          <Text size="sm" c="var(--va-muted)" data-testid="private-hint">
            <IconEyeOff size={14} style={{ verticalAlign: -2 }} /> This demo starts private (only you and
            admins) because something is hidden. You can share it once you've checked it.
          </Text>
        ) : null}
        <Group>
          <Button onClick={submit} disabled={!valid} loading={create.isPending}>
            Make it
          </Button>
          <Button variant="subtle" onClick={props.onBack}>
            Choose another recording
          </Button>
        </Group>
      </Stack>
    </Stack>
  )
}
