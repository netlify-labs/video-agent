// Mock mode only (/dev/clock): the recorder's picture clock (ui/src/recorder/clock) on a real muted MP4, with no mic:
// rVFC anchors, the AudioContext maps, the online piecewise fit, the stop rules and the clip placement it would give;
// and the calibration panel on a switchable route with a synthetic clap listener (claps 45 ms after each flash, one
// outlier). For development and the Playwright specs. Never in production builds: App.tsx mounts it only when
// VITE_MOCK is set.
import { Badge, Button, Code, Divider, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { SAMPLE_RATE } from '../../../src/lib/timeline'
import {
  AudioClock,
  CalibrationPanel,
  CalibrationStore,
  syntheticClapListener,
  type AudioRoute,
  type CalibrationOffsets,
  pictureOffsetFrom,
  placeRecordedTake,
  STOP_MESSAGES,
  usePictureClock,
  type TakeClockInput,
  type TakeFit,
} from '../recorder/clock'

const FPS = 30
// The stem monitor and teleprompter section (va-2qq.4.7, va-2qq.4.8), on its own video and AudioContext. Mounted on
// request, so its second copy of the MP4 doesn't load (and stall the clock's picture) unless it's wanted.
const MonitorDemo = lazy(() => import('./MonitorDemo'))

export default function ClockDemo() {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const audio = useRef<{ ctx: AudioContext; clock: AudioClock } | null>(null)
  const take = useRef<TakeClockInput | null>(null)
  const [fit, setFit] = useState<TakeFit | null>(null)
  const [running, setRunning] = useState(false)
  const picture = usePictureClock(video, { fps: FPS })
  const store = useMemo(() => new CalibrationStore(), [])
  const listener = useMemo(() => syntheticClapListener({ latencyMs: 45 }), [])
  const [rate, setRate] = useState('48000')
  const [epoch, setEpoch] = useState(0)
  const route: AudioRoute = useMemo(
    () => ({ inputDeviceId: 'demo-mic', outputDeviceId: 'default', sampleRate: Number(rate) }),
    [rate],
  )
  const [offsets, setOffsets] = useState<CalibrationOffsets | null>(null)
  const [monitorDemo, setMonitorDemo] = useState(false)

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
  const placement = fit
    ? placeRecordedTake(fit.segments, offsets?.calibrationOffsetSamples ?? 0, offsets?.manualOffsetSamples ?? 0)
    : []
  // A one-second take recorded against composition 1.0 s, placed with the panel's offsets.
  const demoClip = placeRecordedTake(
    [{ fromSample: 0, toSample: SAMPLE_RATE, a: 1, b: 1 / SAMPLE_RATE, residualRms: 0, residualMax: 0, n: 30 }],
    offsets?.calibrationOffsetSamples ?? 0,
    offsets?.manualOffsetSamples ?? 0,
  )[0]
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
      <Divider />
      <Group>
        <Text size="sm">Route sample rate</Text>
        <SegmentedControl
          aria-label="Route sample rate"
          value={rate}
          onChange={setRate}
          data={[
            { value: '48000', label: '48 kHz' },
            { value: '44100', label: '44.1 kHz' },
          ]}
        />
        <Button
          size="xs"
          variant="subtle"
          onClick={() => {
            store.invalidate(route)
            setEpoch((e) => e + 1)
          }}
        >
          Forget this route
        </Button>
      </Group>
      <CalibrationPanel
        key={epoch}
        route={route}
        store={store}
        listener={listener}
        procedure={{ intervalMs: 500, leadInMs: 300, flashMs: 80 }}
        onChange={setOffsets}
      />
      <Text size="sm" data-testid="calibration-offsets" data-offset-samples={offsets?.offsetSamples ?? 0}>
        {offsets
          ? `calibration ${offsets.calibrationOffsetSamples} + manual ${offsets.manualOffsetSamples} = ${offsets.offsetSamples} samples; a take at 1.0 s starts at ${demoClip?.start ?? '-'}`
          : '-'}
      </Text>
      <Divider />
      {monitorDemo ? (
        <Suspense fallback={null}>
          <MonitorDemo />
        </Suspense>
      ) : (
        <Button variant="default" onClick={() => setMonitorDemo(true)}>
          Open the monitor and teleprompter demo
        </Button>
      )}
    </Stack>
  )
}
