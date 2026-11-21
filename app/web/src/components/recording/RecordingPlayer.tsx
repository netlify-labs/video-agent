// Playback on the demo setup's picture: play and pause, a scrubber over the part that's kept (the trim), the time, and
// the recording's sound. It plays from the trim's start to its end and stops there.
import { ActionIcon, Group, Slider, Text } from '@mantine/core'
import { IconPlayerPauseFilled, IconPlayerPlayFilled, IconVolume, IconVolumeOff } from '@tabler/icons-react'
import { useEffect, useState, type RefObject } from 'react'
import { playFrom } from '../../lib/demo-setup'

const fmt = (s: number) => `${String(Math.floor(s / 60))}:${(s % 60).toFixed(1).padStart(4, '0')}`

export function RecordingPlayer(props: {
  video: RefObject<HTMLVideoElement | null>
  /** Seconds of the recording that are kept: [in, out]. */
  trim: [number, number]
}) {
  const [tin, tout] = props.trim
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(tin)
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    const v = props.video.current
    if (!v) return
    let frame = 0
    const tick = () => {
      // Stops at the trim's end.
      if (!v.paused && v.currentTime >= tout) {
        v.pause()
        v.currentTime = tout
      }
      setTime(v.currentTime)
      if (!v.paused) frame = requestAnimationFrame(tick)
    }
    const onPlay = () => {
      setPlaying(true)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    const onPause = () => {
      setPlaying(false)
      setTime(v.currentTime)
    }
    const onSeek = () => {
      setTime(v.currentTime)
    }
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('ended', onPause)
    v.addEventListener('seeked', onSeek)
    v.addEventListener('timeupdate', onSeek)
    if (!v.paused) onPlay()
    return () => {
      cancelAnimationFrame(frame)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('ended', onPause)
      v.removeEventListener('seeked', onSeek)
      v.removeEventListener('timeupdate', onSeek)
    }
  }, [props.video, tout])

  const toggle = () => {
    const v = props.video.current
    if (!v) return
    if (!v.paused) {
      v.pause()
      return
    }
    const from = playFrom(v.currentTime, props.trim)
    if (Math.abs(v.currentTime - from) > 0.01) v.currentTime = from
    // A browser that refuses to play (no data yet, a blocked codec) leaves it paused.
    void v.play().catch(() => undefined)
  }
  const shown = Math.min(tout, Math.max(tin, time))

  return (
    <Group gap="xs" wrap="nowrap" data-testid="recording-player">
      <ActionIcon
        variant="filled"
        radius="xl"
        size="lg"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={toggle}
      >
        {playing ? <IconPlayerPauseFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
      </ActionIcon>
      <Slider
        thumbLabel="Position"
        style={{ flex: 1, minWidth: 0 }}
        min={tin}
        max={tout}
        step={0.1}
        value={shown}
        label={(v) => fmt(v)}
        onChange={(t) => {
          const v = props.video.current
          if (v) v.currentTime = t
          setTime(t)
        }}
      />
      <Text
        size="xs"
        c="var(--va-muted)"
        className="num"
        style={{ whiteSpace: 'nowrap' }}
        data-testid="player-time"
      >
        {fmt(shown)} / {fmt(tout)}
      </Text>
      <ActionIcon
        variant="subtle"
        aria-label={muted ? 'Turn sound on' : 'Mute'}
        aria-pressed={muted}
        onClick={() => {
          const v = props.video.current
          if (v) v.muted = !muted
          setMuted(!muted)
        }}
      >
        {muted ? <IconVolumeOff size={18} /> : <IconVolume size={18} />}
      </ActionIcon>
    </Group>
  )
}
