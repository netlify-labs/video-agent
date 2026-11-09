// Mock mode only (/dev/recorder): drives the voice-over recorder (app/web/src/recorder) on its own, for development and
// the Playwright spec, which supplies the mic through window.__vaTestMic. ?user= sets the owner (so the spec can switch
// accounts); unsaved takes for that user are offered on load. A stopped or recovered take is uploaded to the mock
// server with useTakeUpload, and "saving the draft" is a log line (localStorage.mockFailSave = '1' fails the next
// save). The setup panel (app/web/src/recorder/setup) sits above it: its value feeds createRecorder, and the recorder options
// and track patch it maps to are shown for the spec. Never in production builds: App.tsx mounts it only when VITE_MOCK is set.
import { Button, Code, Group, Stack, Text, Title } from '@mantine/core'
import { useRef, useState } from 'react'
import { SAMPLE_RATE } from '../../../server/lib/timeline'
import { createRecorder, type RecordedTake, type Recorder } from '../recorder/recorder'
import { RecoveryPrompt } from '../recorder/RecoveryPrompt'
import { useRecordingRecovery } from '../recorder/recovery'
import { useTakeUpload } from '../recorder/use-take-upload'
import { RecordingSetup } from '../recorder/setup/RecordingSetup'
import {
  defaultSetup,
  setupToRecorderOptions,
  setupToTrackPatch,
  type RecordingSetupValue,
  type TrackPatch,
} from '../recorder/setup/setup'

const DRAFT = 'draft_demo'

export default function RecorderDemo() {
  const [userId] = useState(() => new URLSearchParams(window.location.search).get('user') ?? 'usr_demo')
  const recovery = useRecordingRecovery(userId, DRAFT)
  const rec = useRef<Recorder | null>(null)
  const [phase, setPhase] = useState<'idle' | 'opening' | 'recording' | 'stopping'>('idle')
  const [level, setLevel] = useState(0)
  const [captured, setCaptured] = useState(0)
  const [take, setTake] = useState<RecordedTake | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string[]>([])
  const [setup, setSetup] = useState<RecordingSetupValue>(() => defaultSetup())
  const [tracks, setTracks] = useState<TrackPatch>(() => setupToTrackPatch(setup))
  const [uploadAsked, setUploadAsked] = useState(false)
  const upload = useTakeUpload({
    userId,
    scopeJobId: 'vid_teaser',
    onTakeReady: async (mediaId, samples, speech) => {
      let fail = false
      try {
        fail = localStorage.getItem('mockFailSave') === '1'
        if (fail) localStorage.removeItem('mockFailSave')
      } catch {
        // ignore
      }
      if (fail) throw new Error("The draft couldn't be saved. Try again.")
      setSaved((l) => [...l, `clip ${mediaId} ${samples} samples, ${speech.length} speech spans`])
    },
  })

  const record = async () => {
    setError(null)
    setTake(null)
    setCaptured(0)
    setPhase('opening')
    try {
      const r = await createRecorder({
        ...setupToRecorderOptions(setup),
        owner: { userId, draftId: DRAFT, expectedRev: 1, scopeJobId: 'vid_teaser' },
        onLevel: (l) => setLevel(l.peak),
        onProgress: (p) => setCaptured(p.samples),
      })
      rec.current = r
      r.start()
      upload.recording(r.recordingId)
      setPhase('recording')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    }
  }

  const show = (t: RecordedTake) => {
    // For the spec: the WAV itself, so it can hash it independently.
    ;(window as unknown as { __vaTake?: RecordedTake }).__vaTake = t
    setTake(t)
  }

  const stop = async () => {
    const r = rec.current
    if (!r) return
    setPhase('stopping')
    let t: RecordedTake | null = null
    try {
      t = await r.stop()
      show(t)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    rec.current = null
    setPhase('idle')
    if (t) await upload.upload(t)
  }

  return (
    <Stack gap="md">
      <div>
        <Title order={1}>Recorder</Title>
        <Text size="sm" c="var(--va-muted)">
          The voice-over recorder on its own (mock data), as {userId}.
        </Text>
      </div>
      <RecordingSetup
        value={setup}
        onChange={(v, t) => {
          setSetup(v)
          setTracks(t)
        }}
        onUploadInstead={() => {
          setUploadAsked(true)
        }}
        locked={phase !== 'idle'}
      />
      <Code block data-testid="setup-options">
        {JSON.stringify({ recorder: setupToRecorderOptions(setup), tracks })}
      </Code>
      {uploadAsked ? (
        <Text size="sm" data-testid="upload-instead">
          Upload instead was chosen.
        </Text>
      ) : null}
      <RecoveryPrompt
        takes={recovery.takes}
        onRecover={async (t) => {
          const r = await recovery.recover(t.id)
          show(r.take)
          void upload.upload(r.take, r.record)
        }}
        onDiscard={(t) => recovery.discard(t.id)}
      />
      <Group>
        <Button onClick={() => void record()} disabled={phase !== 'idle'}>
          Record
        </Button>
        <Button onClick={() => void stop()} disabled={phase !== 'recording'}>
          Stop
        </Button>
      </Group>
      <Text size="sm" data-testid="recorder-phase">
        {phase}
      </Text>
      <Text size="sm">
        Level {level.toFixed(2)} · captured {(captured / SAMPLE_RATE).toFixed(1)} s
      </Text>
      <Group gap="xs">
        <Text size="sm">
          Take: <span data-testid="take-state">{upload.state}</span>
          {upload.error ? ` · ${upload.error}` : ''}
        </Text>
        {upload.state === 'failed' ? (
          <Button size="xs" variant="default" onClick={() => void upload.retry()}>
            Retry
          </Button>
        ) : null}
      </Group>
      {saved.map((line) => (
        <Text key={line} size="sm" data-testid="saved-clip">
          {line}
        </Text>
      ))}
      {error ? (
        <Text c="red" size="sm" role="alert">
          {error}
        </Text>
      ) : null}
      {take ? (
        <Code block data-testid="recorder-take">
          {JSON.stringify({
            recordingId: take.recordingId,
            samples: take.samples,
            bytes: take.wav.size,
            sha256: take.sha256,
            peaks: take.peaks.length,
            speech: take.speech,
            firstSampleContextTime: take.firstSampleContextTime,
            persisted: take.persisted,
          })}
        </Code>
      ) : null}
    </Stack>
  )
}
