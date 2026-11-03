// Mock mode only (a section of /dev/clock): the stem monitor and the teleprompter on the muted MP4, with no backend.
// A synthetic 8 s composition (music 0-8 s, AI voice in intro and outro, an existing narration clip at 6.5-7.5 s) whose
// stems and take are made in the page as 24 kHz WAVs: music a 220 Hz tone, each AI voice a 1 kHz tone, the narration
// a 330 Hz tone, so the Playwright spec can tell them apart in a recorded take. Arm creates the AudioContext (the
// gesture), the clock, the recorder and, through useStemMonitor, the monitor; Record plays the picture and records.
// With the spec's stand-in mic, window.__vaTestMicTap is the mic's input: the monitor's output is connected to it, a
// loopback, so the take holds exactly what the monitor played. Never in production builds.
import { Badge, Button, Code, Group, SegmentedControl, Stack, Switch, Text, Title } from '@mantine/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IDENTITY_FIT, SAMPLE_RATE, type AiVoiceMode, type NarrationOp } from '../../../src/lib/timeline'
import { AudioClock, usePictureClock } from '../recorder/clock'
import { useStemMonitor, type OutputMode, type StemMonitorStats } from '../recorder/monitor'
import { createRecorder, type RecordedTake, type Recorder } from '../recorder/recorder'
import { floatToPcm16, wavHeader } from '../recorder/wav'
import { PrompterLayout, Teleprompter, pictureTime } from '../recorder/teleprompter'

declare global {
  interface Window {
    /** Mock builds only: the stand-in mic's input node, for a monitor loopback. */
    __vaTestMicTap?: AudioNode
    /** Mock builds only: the demo's stems (24 kHz mono) by src, for the spec's correlation. */
    __vaMonitorStems?: Record<string, Float32Array>
    __vaMonitorTake?: RecordedTake
  }
}

const S = SAMPLE_RATE
const DURATION = 8

const HTML = `<!doctype html><html><body>
<div id="root" data-composition-id="main" data-va-contract="1" data-start="0" data-duration="${DURATION}" data-width="1920" data-height="1080">
  <audio id="music" data-va-layer="music" data-va-label="Music" data-va-duck="0.3" src="assets/media/music.wav" data-start="0" data-duration="${DURATION}" data-track-index="2" data-volume="0.5"></audio>
  <section id="intro" class="clip" data-va-beat="intro" data-composition-id="intro" data-start="0" data-duration="3" data-va-authored-duration="3" data-track-index="0">
    <audio id="voice-intro" data-va-voice="intro" src="assets/voice/intro.wav" data-start="0.5" data-duration="2" data-track-index="3" data-volume="1"></audio>
    <h1 data-va-text="intro-title">Org webhooks</h1>
  </section>
  <section id="demo" class="clip" data-va-beat="demo" data-composition-id="demo" data-start="3" data-duration="3" data-va-authored-duration="3" data-track-index="0">
    <p data-va-text="demo-sub">One subscription for every project</p>
  </section>
  <section id="outro" class="clip" data-va-beat="outro" data-composition-id="outro" data-start="6" data-duration="2" data-va-authored-duration="2" data-track-index="0">
    <audio id="voice-outro" data-va-voice="outro" src="assets/voice/outro.wav" data-start="0.2" data-duration="1.5" data-track-index="3" data-volume="1"></audio>
    <h2 data-va-text="outro-cta">Read the docs</h2>
  </section>
</div></body></html>`

const SCRIPT = [
  'Webhooks for your whole organization.',
  'One subscription covers every project.',
  'Read the docs to start.',
]

const tone = (seconds: number, hz: number, amp: number) =>
  Float32Array.from({ length: Math.round(seconds * S) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / S))
const STEMS: Record<string, Float32Array> = {
  'assets/media/music.wav': tone(DURATION, 220, 0.3),
  'assets/voice/intro.wav': tone(2, 1000, 0.5),
  'assets/voice/outro.wav': tone(1.5, 1000, 0.5),
}
const TAKE = tone(1, 330, 0.4)
/** A canonical 24 kHz mono PCM16 WAV, as the recorder writes them. */
const toWav = async (pcm: Float32Array) =>
  new Blob([wavHeader(pcm.length, S), floatToPcm16(pcm)]).arrayBuffer()

const OP: NarrationOp = {
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips: [
    {
      id: 'existing',
      mediaId: 'take_demo',
      srcStart: 0,
      srcEnd: S,
      fit: IDENTITY_FIT,
      offsetSamples: 0,
      start: 6.5 * S,
      gainDb: 0,
      fadeInSamples: 240,
      fadeOutSamples: 240,
    },
  ],
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'off',
}
const TAKE_SAMPLES = new Map([['take_demo', S]])

export default function MonitorDemo() {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const picture = usePictureClock(video, { fps: 30 })
  const [mode, setMode] = useState<AiVoiceMode>('replace')
  const [output, setOutput] = useState<OutputMode>('headphones')
  const [useScript, setUseScript] = useState(false)
  const [armPunch, setArmPunch] = useState(false)
  const [audio, setAudio] = useState<{ ctx: AudioContext; clock: AudioClock } | null>(null)
  const rec = useRef<Recorder | null>(null)
  const detach = useRef<(() => void) | null>(null)
  const [phase, setPhase] = useState<'idle' | 'armed' | 'recording' | 'stopped'>('idle')
  const [stats, setStats] = useState<StemMonitorStats | null>(null)
  const [take, setTake] = useState<RecordedTake | null>(null)

  useEffect(() => {
    window.__vaMonitorStems = STEMS
  }, [])
  const monitorAudio = useMemo(() => ({ aiVoice: { mode, volumeDb: -12 } }), [mode])
  const monitor = useStemMonitor({
    context: audio?.ctx ?? null,
    clock: audio?.clock ?? null,
    html: HTML,
    op: OP,
    audio: monitorAudio,
    takeSamples: TAKE_SAMPLES,
    takeLoader: () => toWav(TAKE),
    stemLoader: async (src) => {
      const pcm = STEMS[src]
      if (!pcm) throw new Error(`no stem ${src}`)
      return toWav(pcm)
    },
    outputMode: output,
  })
  // The loopback: what the monitor plays goes into the stand-in mic too.
  const m = monitor.monitor
  useEffect(() => {
    const tap = window.__vaTestMicTap
    if (!m || !tap) return
    m.output.connect(tap)
    return () => {
      try {
        m.output.disconnect(tap)
      } catch {
        // already disconnected by dispose
      }
    }
  }, [m])
  const { setArmedRange, stats: monitorStats } = monitor
  useEffect(() => {
    setArmedRange(armPunch ? [6 * S, 8 * S] : null)
  }, [armPunch, setArmedRange, m])
  useEffect(() => {
    if (phase !== 'recording') return
    const t = setInterval(() => setStats(monitorStats()), 250)
    return () => clearInterval(t)
  }, [phase, monitorStats])

  const audioRef = useRef(audio)
  audioRef.current = audio
  const release = useCallback(() => {
    void rec.current?.cancel()
    rec.current = null
    audioRef.current?.clock.stop()
    void audioRef.current?.ctx.close()
  }, [])
  useEffect(() => release, [release])

  async function arm() {
    release()
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await ctx.resume()
    const clock = new AudioClock(ctx).start()
    rec.current = await createRecorder({ context: ctx, echoCancellation: output === 'speakers' })
    setAudio({ ctx, clock })
    setTake(null)
    setPhase('armed')
  }

  async function record() {
    const r = rec.current
    if (!video || !audio || !r) return
    video.pause()
    if (video.currentTime !== 0) {
      video.currentTime = 0
      await new Promise((res) => video.addEventListener('seeked', res, { once: true }))
    }
    const c = picture.start({ audioClock: audio.clock, context: audio.ctx })
    if (!c) return
    detach.current = monitor.attach(c)
    r.start()
    setPhase('recording')
    await video.play()
  }

  const stop = useCallback(async () => {
    detach.current?.()
    detach.current = null
    picture.stop('user')
    video?.pause()
    setStats(monitor.stats())
    monitor.stop()
    const r = rec.current
    rec.current = null
    if (!r) return
    const t = await r.stop()
    window.__vaMonitorTake = t
    setTake(t)
    setPhase('stopped')
  }, [picture, video, monitor])

  const getTime = useCallback(
    () => pictureTime(picture.anchors, performance.now()) ?? video?.currentTime ?? 0,
    [picture, video],
  )

  return (
    <Stack gap="md">
      <Title order={2}>Monitor mix and teleprompter</Title>
      <Text size="sm" c="dimmed">
        The draft&apos;s stems in the recording&apos;s AudioContext, scheduled from the picture: music
        pre-ducked from the existing narration, the AI voice by mode, the existing clip muted in an armed
        punch range.
      </Text>
      <Group>
        <SegmentedControl
          aria-label="Original audio"
          value={mode}
          onChange={setMode}
          disabled={phase === 'recording'}
          data={[
            { value: 'replace', label: 'Replace AI voice' },
            { value: 'under', label: 'Under my voice' },
            { value: 'keep', label: 'Keep AI voice' },
          ]}
        />
        <SegmentedControl
          aria-label="Output"
          value={output}
          onChange={setOutput}
          disabled={phase === 'recording'}
          data={[
            { value: 'headphones', label: 'Headphones' },
            { value: 'speakers', label: 'Speakers' },
          ]}
        />
        <Switch
          label="AI script"
          checked={useScript}
          onChange={(e) => setUseScript(e.currentTarget.checked)}
        />
        <Switch
          label="Arm punch 6-8 s"
          checked={armPunch}
          onChange={(e) => setArmPunch(e.currentTarget.checked)}
        />
      </Group>
      <PrompterLayout
        picture={
          <video
            ref={setVideo}
            src="/teaser-v2.mp4"
            muted
            playsInline
            preload="auto"
            data-testid="monitor-video"
            style={{ width: '100%', background: '#000' }}
          />
        }
        prompter={<Teleprompter composition={HTML} script={useScript ? SCRIPT : null} getTime={getTime} />}
      />
      <Group>
        <Button onClick={() => void arm()} disabled={phase === 'armed' || phase === 'recording'}>
          Arm
        </Button>
        <Button onClick={() => void record()} disabled={phase !== 'armed' || !monitor.ready}>
          Record with monitor
        </Button>
        <Button variant="default" onClick={() => void stop()} disabled={phase !== 'recording'}>
          End take
        </Button>
        <Badge data-testid="monitor-phase" variant="light">
          {phase === 'armed' && !monitor.ready ? 'loading' : phase}
        </Badge>
      </Group>
      <Code block data-testid="monitor-stats">
        {stats
          ? JSON.stringify({
              running: stats.running,
              resyncs: stats.resyncs,
              driftMs: stats.driftMs === null ? null : Math.round(stats.driftMs * 100) / 100,
              stems: stats.stems,
              scheduled: stats.scheduled,
              chunks: stats.chunks,
              level: stats.level,
              failures: stats.failures,
              take: take
                ? { samples: take.samples, firstSampleContextTime: take.firstSampleContextTime }
                : null,
            })
          : 'Not started.'}
      </Code>
    </Stack>
  )
}
