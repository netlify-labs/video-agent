// Mock mode only (/dev/clock): the recorder's picture clock (ui/src/recorder/clock) on a real muted MP4, with no mic:
// rVFC anchors, the AudioContext maps, the online piecewise fit, the stop rules and the clip placement it would give,
// for development and the Playwright spec. Never in production builds: App.tsx mounts it only when VITE_MOCK is set.
import { Badge, Button, Code, Group, Stack, Text, Title } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import {
  AudioClock,
  pictureOffsetFrom,
  placeRecordedTake,
  STOP_MESSAGES,
  usePictureClock,
  type TakeClockInput,
  type TakeFit,
} from '../recorder/clock'

const FPS = 30

export default function ClockDemo() {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const audio = useRef<{ ctx: AudioContext; clock: AudioClock } | null>(null)
  const take = useRef<TakeClockInput | null>(null)
  const [fit, setFit] = useState<TakeFit | null>(null)
  const [running, setRunning] = useState(false)
  const picture = usePictureClock(video, { fps: FPS })

  useEffect(
    () => () => {
      audio.current?.clock.stop()
      void audio.current?.ctx.close()
    },
    [],
  )
  const { fitFor, onStop } = picture
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setFit(fitFor()), 500)
    return () => clearInterval(t)
  }, [running, fitFor])
  useEffect(
    () =>
      onStop(() => {
        video?.pause()
        setRunning(false)
        setFit(fitFor())
      }),
    [onStop, fitFor, video],
  )

  async function start() {
    if (!video) return
    // The Record click is the gesture that starts the context and playback.
    const ctx = audio.current?.ctx ?? new AudioContext()
    await ctx.resume()
    const clock = audio.current?.clock ?? new AudioClock(ctx).start()
    clock.reset()
    audio.current = { ctx, clock }
    video.pause()
    // Rewind before arming: a seek while armed stops the take.
    if (video.currentTime !== 0) {
      video.currentTime = 0
      await new Promise((r) => video.addEventListener('seeked', r, { once: true }))
    }
    picture.start({ audioClock: clock, context: ctx })
    take.current = { startFrame: Math.round(ctx.currentTime * ctx.sampleRate) }
    picture.beginTake(take.current)
    setFit(null)
    setRunning(true)
    await video.play()
  }

  const offset = pictureOffsetFrom(picture.anchors)
  const placement = fit ? placeRecordedTake(fit.segments, 0, 0) : []
  const stop = picture.stopReason
  return (
    <Stack gap="md" maw={900}>
      <Title order={2}>Picture clock</Title>
      <Text size="sm" c="dimmed">
        A muted MP4 with requestVideoFrameCallback anchors, fitted against this page&apos;s AudioContext clock. Seeking,
        hiding the tab or a stall stops the take.
      </Text>
      <video
        ref={setVideo}
        src="/teaser-v2.mp4"
        muted
        playsInline
        preload="auto"
        data-testid="clock-video"
        style={{ width: 480, maxWidth: '100%', background: '#000' }}
      />
      <Group>
        <Button onClick={() => void start()} disabled={running}>
          Start
        </Button>
        <Button variant="default" onClick={() => picture.stop('user')} disabled={!running}>
          Stop
        </Button>
        <Badge data-testid="clock-state" variant="light">
          {running ? 'running' : stop ? 'stopped' : 'idle'}
        </Badge>
      </Group>
      <Text size="sm">
        Anchors: <span data-testid="clock-anchors">{picture.anchorCount}</span> · picture offset (10-anchor median):{' '}
        <span data-testid="clock-offset">{offset === null ? '-' : `${(offset * 1000).toFixed(1)} ms`}</span> · output
        map: <span data-testid="clock-output">{fit?.outputSource ?? '-'}</span>
      </Text>
      <Text size="sm" data-testid="clock-stop" data-kind={stop?.kind ?? ''}>
        {stop ? `${stop.kind}: ${STOP_MESSAGES[stop.kind]}` : 'No stop.'}
      </Text>
      <Code block data-testid="clock-fit" data-segments={fit?.segments.length ?? 0}>
        {fit
          ? JSON.stringify(
              {
                anchors: fit.anchors,
                cleanSamples: fit.cleanSamples,
                slopePpm: fit.slopePpm === null ? null : Math.round(fit.slopePpm),
                steps: fit.steps.length,
                outliers: fit.outliers,
                skippedFrames: fit.skippedFrames,
                segments: fit.segments.map((s) => ({
                  from: Math.round(s.fromSample),
                  to: Math.round(s.toSample),
                  a: Number(s.a.toFixed(4)),
                  rmsMs: Number(s.residualRms.toFixed(2)),
                  maxMs: Number(s.residualMax.toFixed(2)),
                })),
                placement,
              },
              null,
              2,
            )
          : 'No fit yet.'}
      </Code>
    </Stack>
  )
}
