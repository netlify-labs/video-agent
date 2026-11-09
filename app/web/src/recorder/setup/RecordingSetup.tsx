// The voice-over setup panel (plan 2026-11-02 §2.1 step 2, §5.1): mic picker with a live meter and a 3 s level check,
// output mode (headphones, or speakers with the monitor muted or lowered and echo cancellation on), a slot for the
// route calibration, and what happens to the original audio. Controlled: the caller owns the value and gets the
// NarrationOp track patch with every change (the editor owns the op); setupToRecorderOptions(value) feeds the take.
// While `locked` (a take is running) every choice is fixed and the preview mic is released.
import {
  Alert,
  Button,
  Group,
  Radio,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CLIP_DB, meterPercent, QUIET_DB, VERDICT_COPY } from './level'
import { browserOf, listInputs, PROBLEM_COPY, type MicInput } from './mic'
import {
  AI_VOICE_DB_MAX,
  AI_VOICE_DB_MIN,
  DUCK_DB,
  originalAudio,
  saveDeviceId,
  setupToTrackPatch,
  withOriginalAudio,
  withOutputMode,
  type RecordingSetupValue,
  type TrackPatch,
} from './setup'
import { useMicPreview, type MeterReading } from './use-mic-preview'

const DEFAULT = '__default'
const fmtDb = (db: number) => `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(Math.round(db))} dB`

function Meter({ reading }: { reading: MeterReading }) {
  const rms = meterPercent(reading.rmsDb)
  const peak = meterPercent(reading.peakDb)
  const hot = reading.peakDb >= CLIP_DB
  return (
    <Group gap="xs" wrap="nowrap">
      <div
        role="meter"
        aria-label="Input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rms}
        aria-valuetext={`${Math.round(reading.rmsDb)} dBFS`}
        data-testid="mic-meter"
        data-rms-db={reading.rmsDb.toFixed(1)}
        data-peak-db={reading.peakDb.toFixed(1)}
        style={{
          position: 'relative',
          flex: 1,
          height: 10,
          borderRadius: 5,
          background: 'var(--va-raised)',
          overflow: 'hidden',
        }}
      >
        {/* The quiet line: speech should reach past it. */}
        <div
          style={{
            position: 'absolute',
            left: `${meterPercent(QUIET_DB)}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: 'var(--va-rule)',
          }}
        />
        <div
          style={{
            width: `${rms}%`,
            height: '100%',
            background: hot ? 'var(--va-negative)' : 'var(--va-accent)',
            transition: 'width 50ms linear',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: `calc(${peak}% - 2px)`,
            top: 0,
            bottom: 0,
            width: 2,
            background: hot ? 'var(--va-negative)' : 'var(--va-text)',
          }}
        />
      </div>
      <Text
        size="xs"
        fw={600}
        data-testid="mic-clip"
        data-on={reading.clip ? 'true' : 'false'}
        c={reading.clip ? 'var(--va-negative)' : 'var(--va-faint)'}
        w={32}
      >
        CLIP
      </Text>
    </Group>
  )
}

export function RecordingSetup(props: {
  value: RecordingSetupValue
  onChange: (v: RecordingSetupValue, tracks: TrackPatch) => void
  /** The mic opened (with the input it opened), or it's denied or missing (null). */
  onReady?: (mic: { deviceId: string; label: string } | null) => void
  /** The mic is unavailable or the person prefers a file: upload a recording instead. */
  onUploadInstead?: () => void
  /** The route calibration (§5.3), placed by the record flow. */
  calibrationSlot?: ReactNode
  /** A take is running: every choice is fixed and the preview mic is released. */
  locked?: boolean
}) {
  const { value: v, locked = false } = props
  const mic = useMicPreview()
  const [inputs, setInputs] = useState<MicInput[]>([])
  const latest = useRef({ v, onChange: props.onChange, onReady: props.onReady })
  latest.current = { v, onChange: props.onChange, onReady: props.onReady }
  const set = (next: RecordingSetupValue) => {
    props.onChange(next, setupToTrackPatch(next))
  }

  const refresh = async () => {
    const list = await listInputs().catch(() => [])
    setInputs(list)
    return list
  }
  useEffect(() => {
    void refresh()
    const md = navigator.mediaDevices as MediaDevices | undefined
    if (!md?.addEventListener) return
    const onDevices = () => {
      void refresh().then((list) => {
        const cur = latest.current
        // The chosen mic went away: back to the default one (the reopen effect follows).
        if (cur.v.deviceId && !list.some((d) => d.deviceId === cur.v.deviceId)) {
          const next = { ...cur.v, deviceId: null }
          cur.onChange(next, setupToTrackPatch(next))
        }
      })
    }
    md.addEventListener('devicechange', onDevices)
    return () => {
      md.removeEventListener('devicechange', onDevices)
    }
  }, [])

  const start = async () => {
    const s = await mic.open({ deviceId: v.deviceId, echoCancellation: v.echoCancellation })
    if (s.status === 'live') {
      await refresh()
      latest.current.onReady?.({ deviceId: s.deviceId, label: s.label })
    } else if (s.status === 'problem') latest.current.onReady?.(null)
  }

  // While the preview is open, a new mic or echo setting reopens it, so the meter hears what the take will.
  const opened = mic.state.status === 'live' || mic.state.status === 'opening'
  const key = `${v.deviceId ?? ''}|${v.echoCancellation}`
  const openedKey = useRef(key)
  useEffect(() => {
    if (locked) {
      if (opened) mic.close()
      return
    }
    if (opened && openedKey.current !== key) void start()
    openedKey.current = key
  }, [key, locked])

  // A live track that ends (unplugged, revoked) is a missing mic.
  useEffect(() => {
    const t = mic.stream.current?.getAudioTracks()[0]
    if (!t || mic.state.status !== 'live') return
    const onEnded = () => {
      void start()
    }
    t.addEventListener('ended', onEnded)
    return () => {
      t.removeEventListener('ended', onEnded)
    }
  }, [mic.state])

  const problem = mic.state.status === 'problem' ? mic.state.problem : null
  const live = mic.state.status === 'live'
  const browser = browserOf(navigator.userAgent)
  const mac = /Mac OS X|Macintosh/.test(navigator.userAgent)
  const verdict = mic.result ? VERDICT_COPY[mic.result.verdict] : null
  const options = [
    { value: DEFAULT, label: 'Default microphone' },
    ...inputs.map((d) => ({ value: d.deviceId, label: d.label })),
  ]
  const chosen = v.deviceId && inputs.some((d) => d.deviceId === v.deviceId) ? v.deviceId : DEFAULT

  return (
    <Stack gap="lg" data-testid="recording-setup">
      <Stack gap="xs">
        <Title order={4}>Microphone</Title>
        {problem ? (
          <Alert color="red" variant="light" title={PROBLEM_COPY[problem].title} data-testid="mic-problem">
            <Stack gap="xs">
              <Text size="sm">{PROBLEM_COPY[problem].help(browser, mac)}</Text>
              <Group gap="xs">
                <Button size="xs" onClick={() => void start()} disabled={locked}>
                  Retry
                </Button>
                {props.onUploadInstead ? (
                  <Button size="xs" variant="default" onClick={props.onUploadInstead}>
                    Upload a file instead
                  </Button>
                ) : null}
              </Group>
            </Stack>
          </Alert>
        ) : null}
        <Group gap="sm" align="end" wrap="wrap">
          <Select
            label="Input"
            data={options}
            value={chosen}
            allowDeselect={false}
            disabled={locked}
            w={280}
            onChange={(x) => {
              const deviceId = !x || x === DEFAULT ? null : x
              saveDeviceId(deviceId)
              set({ ...v, deviceId })
            }}
            data-testid="mic-select"
          />
          {!live && !problem ? (
            <Button onClick={() => void start()} loading={mic.state.status === 'opening'} disabled={locked}>
              Check mic
            </Button>
          ) : null}
        </Group>
        {live ? (
          <Stack gap={6}>
            <Meter reading={mic.reading} />
            <Group gap="sm">
              <Button
                size="xs"
                variant="default"
                onClick={mic.check}
                loading={mic.checking}
                disabled={locked}
              >
                Check level
              </Button>
              <Text size="xs" c="var(--va-muted)">
                {mic.checking
                  ? 'Speak as you will in the take…'
                  : 'Read a line for 3 seconds at your recording voice.'}
              </Text>
            </Group>
            {verdict && mic.result ? (
              <Text
                size="sm"
                data-testid="level-verdict"
                data-verdict={mic.result.verdict}
                c={mic.result.verdict === 'ok' ? 'var(--va-text)' : 'var(--va-negative)'}
              >
                <b>{verdict.title}</b> ({Math.round(mic.result.rmsDb)} dBFS, peak{' '}
                {Math.round(mic.result.peakDb)}). {verdict.help}
              </Text>
            ) : null}
          </Stack>
        ) : null}
      </Stack>

      <Stack gap="xs">
        <Title order={4}>Output</Title>
        <SegmentedControl
          value={v.outputMode}
          disabled={locked}
          data={[
            { value: 'headphones', label: 'Headphones' },
            { value: 'speakers', label: 'Speakers' },
          ]}
          onChange={(x) => {
            set(withOutputMode(v, x))
          }}
          data-testid="output-mode"
          w="fit-content"
        />
        <Text size="sm" c="var(--va-muted)">
          {v.outputMode === 'headphones'
            ? 'You hear the video while you record.'
            : "Echo cancellation is on, and the video's sound is kept away from your mic while you record."}{' '}
          The choice holds for the whole take.
        </Text>
        {v.outputMode === 'speakers' ? (
          <Radio.Group
            label="While recording"
            value={v.monitorDuringRecord}
            onChange={(x) => {
              set({ ...v, monitorDuringRecord: x })
            }}
          >
            <Group gap="md" mt={4}>
              <Radio value="mute" label="Mute the video" disabled={locked} />
              <Radio value="duck" label={`Play it quietly (${fmtDb(DUCK_DB)})`} disabled={locked} />
            </Group>
          </Radio.Group>
        ) : null}
        <Text size="xs" c="var(--va-faint)">
          Bluetooth adds delay and lowers mic quality; wired is best.
        </Text>
        {props.calibrationSlot}
      </Stack>

      <Stack gap="xs">
        <Title order={4}>Original audio</Title>
        <Radio.Group
          value={originalAudio(v)}
          onChange={(x) => {
            set(withOriginalAudio(v, x))
          }}
          data-testid="original-audio"
        >
          <Stack gap={6}>
            <Radio
              value="replace"
              label="Replace AI voice-over"
              description="The AI voice is muted, and kept so you can bring it back."
              disabled={locked}
            />
            <Radio value="under" label="Keep it under my voice" disabled={locked} />
            <Radio value="muteAll" label="Mute all original audio" disabled={locked} />
          </Stack>
        </Radio.Group>
        {originalAudio(v) === 'under' ? (
          <Group gap="sm" wrap="nowrap" maw={360}>
            <Text size="sm" w={90}>
              AI voice
            </Text>
            <Slider
              flex={1}
              size="sm"
              min={AI_VOICE_DB_MIN}
              max={AI_VOICE_DB_MAX}
              step={1}
              value={v.aiVoiceDb}
              disabled={locked}
              label={fmtDb}
              onChange={(db) => {
                set({ ...v, aiVoiceDb: db })
              }}
              aria-label="AI voice level"
              data-testid="ai-voice-db"
            />
            <Text size="sm" w={56} ta="right">
              {fmtDb(v.aiVoiceDb)}
            </Text>
          </Group>
        ) : null}
      </Stack>

      {props.onUploadInstead && !problem ? (
        <Group>
          <Button size="xs" variant="subtle" onClick={props.onUploadInstead} disabled={locked}>
            Upload a file instead
          </Button>
        </Group>
      ) : null}
    </Stack>
  )
}
