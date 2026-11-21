// A track's player in the media library: play and pause, a scrubber, the time and the sound. Unlike the browser's own
// player it shows the track's length from the library's record, before any of the file has loaded. The file starts
// loading when someone points at the player or tabs to it (or at once, with `eager`), so play starts sooner.
import { ActionIcon, Group, Slider, Text } from '@mantine/core'
import { IconPlayerPauseFilled, IconPlayerPlayFilled, IconVolume, IconVolumeOff } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import { clockTime } from './bits'

/** Starts loading a player that was waiting for a press. */
export function warmAudio(a: HTMLAudioElement | null) {
  if (!a || a.preload !== 'none') return
  a.preload = 'auto'
  if (a.paused && a.readyState === 0) a.load()
}

// One track plays at a time across the page.
let playing: HTMLAudioElement | null = null

/** Plays this track and pauses the one that was playing. */
export function playOnly(a: HTMLAudioElement) {
  if (playing && playing !== a) playing.pause()
  playing = a
  // A browser that refuses to play (no data yet, a blocked codec) leaves it paused.
  void a.play().catch(() => undefined)
}

export function AudioPlayer(props: {
  src: string
  /** What it plays, for the buttons' names. */
  name: string
  /** The track's length as the library has it; shown until the file says otherwise. */
  durationSec?: number | null
  /** Load the file at once instead of waiting for the pointer. */
  eager?: boolean
  className?: string
  testId?: string
}) {
  const ref = useRef<HTMLAudioElement>(null)
  const [on, setOn] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(props.durationSec ?? 0)
  const [muted, setMuted] = useState(false)
  const warm = () => {
    warmAudio(ref.current)
  }
  return (
    <Group
      gap={6}
      wrap="nowrap"
      className={props.className}
      onPointerEnter={warm}
      onTouchStart={warm}
      onFocus={warm}
      onClick={(e) => {
        e.stopPropagation()
      }}
    >
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={`${on ? 'Pause' : 'Play'} ${props.name}`}
        aria-pressed={on}
        onClick={() => {
          const a = ref.current
          if (!a) return
          if (a.paused) playOnly(a)
          else a.pause()
        }}
      >
        {on ? <IconPlayerPauseFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
      </ActionIcon>
      <Text size="xs" className="num" style={{ whiteSpace: 'nowrap' }} data-testid="audio-time">
        {clockTime(time)} / {length ? clockTime(Math.round(length)) : '–:––'}
      </Text>
      <Slider
        thumbLabel={`Position in ${props.name}`}
        size="xs"
        style={{ flex: 1, minWidth: 0 }}
        min={0}
        max={Math.max(length, 0.1)}
        step={0.1}
        value={Math.min(time, Math.max(length, 0.1))}
        label={(v) => clockTime(v)}
        disabled={!length}
        onChange={(t) => {
          const a = ref.current
          if (a) {
            warmAudio(a)
            a.currentTime = t
          }
          setTime(t)
        }}
      />
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={muted ? 'Turn sound on' : 'Mute'}
        aria-pressed={muted}
        onClick={() => {
          const a = ref.current
          if (a) a.muted = !muted
          setMuted(!muted)
        }}
      >
        {muted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
      </ActionIcon>
      <audio
        ref={ref}
        preload={props.eager ? 'auto' : 'none'}
        src={props.src}
        data-testid={props.testId}
        onPlay={() => {
          setOn(true)
        }}
        onPause={() => {
          setOn(false)
        }}
        onEnded={() => {
          setOn(false)
        }}
        onTimeUpdate={(e) => {
          setTime(e.currentTarget.currentTime)
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setLength(d)
        }}
      />
    </Group>
  )
}
