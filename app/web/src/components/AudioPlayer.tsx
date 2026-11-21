// A track's player in the media library: play and pause, a scrubber, the time and the sound. Unlike the browser's own
// player it shows the track's length from the library's record, before any of the file has loaded. The file starts
// loading when someone points at the player or tabs to it (or at once, with `eager`), so play starts sooner. While a
// press is waiting for the file it shows a spinner; when the file can't be loaded or played it says so, with the
// reason, and the next press tries again.
import { ActionIcon, Group, Loader, Slider, Stack, Text } from '@mantine/core'
import { IconPlayerPauseFilled, IconPlayerPlayFilled, IconVolume, IconVolumeOff } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { clockTime } from './bits'

/** Starts loading a player that was waiting for a press. */
export function warmAudio(a: HTMLAudioElement | null) {
  if (!a || a.preload !== 'none') return
  a.preload = 'auto'
  if (a.paused && a.readyState === 0 && !a.error) a.load()
}

// One track plays at a time across the page.
let playing: HTMLAudioElement | null = null

/** Plays this track and pauses the one that was playing. Resolves to why it couldn't, or null. */
export function playOnly(a: HTMLAudioElement): Promise<string | null> {
  if (playing && playing !== a) playing.pause()
  playing = a
  return a.play().then(
    () => null,
    // A press on pause before it started isn't a failure.
    (e: unknown) => (e instanceof DOMException && e.name === 'AbortError' ? null : playError(a, e)),
  )
}

const MEDIA_ERRORS: Record<number, string> = {
  1: 'the load was stopped',
  2: "the file didn't download (the link may have expired, or the network dropped)",
  3: "the browser couldn't decode it",
  4: "the file couldn't be opened (the link may have expired, or the browser can't play this kind of file)",
}

/** Why a track didn't play, in words. */
export function playError(a: HTMLAudioElement, e?: unknown) {
  if (a.error) return MEDIA_ERRORS[a.error.code] ?? 'the browser gave no reason'
  if (e instanceof DOMException && e.name === 'NotAllowedError')
    return 'the browser blocked playback on this page'
  if (e instanceof DOMException && e.name === 'NotSupportedError') return MEDIA_ERRORS[4] ?? ''
  return e instanceof Error ? e.message : 'the browser gave no reason'
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
  // The link in use. A newer one (the list refreshed its signed links) replaces it only while nothing is loaded, so
  // a refresh never restarts a track that's loaded or playing.
  const [src, setSrc] = useState(props.src)
  const [on, setOn] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(props.durationSec ?? 0)
  const [muted, setMuted] = useState(false)
  useEffect(() => {
    const a = ref.current
    if (props.src !== src && (!a || a.readyState === 0)) setSrc(props.src)
  }, [props.src, src])
  const warm = () => {
    warmAudio(ref.current)
  }
  const toggle = () => {
    const a = ref.current
    if (!a) return
    if (!a.paused) {
      a.pause()
      return
    }
    // After a failure, start over (with the newest link, which the effect above has put in place).
    if (a.error) a.load()
    setFailed(null)
    setWaiting(true)
    void playOnly(a).then((why) => {
      setWaiting(false)
      if (why) setFailed(why)
    })
  }
  return (
    <Stack gap={2} className={props.className} style={{ width: '100%' }}>
      <Group
        gap={6}
        wrap="nowrap"
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
          aria-busy={waiting}
          onClick={toggle}
        >
          {waiting ? (
            <Loader size={14} color="gray" />
          ) : on ? (
            <IconPlayerPauseFilled size={16} />
          ) : (
            <IconPlayerPlayFilled size={16} />
          )}
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
          src={src}
          data-testid={props.testId}
          onPlaying={() => {
            setOn(true)
            setWaiting(false)
            setFailed(null)
          }}
          onWaiting={() => {
            setWaiting(true)
          }}
          onPause={() => {
            setOn(false)
            setWaiting(false)
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
          onError={(e) => {
            setOn(false)
            setWaiting(false)
            setFailed(playError(e.currentTarget))
          }}
        />
      </Group>
      {failed ? (
        <Text size="xs" c="red" role="alert" data-testid="audio-error" px={4}>
          It didn’t play: {failed}. Press play to try again.
        </Text>
      ) : null}
    </Stack>
  )
}
