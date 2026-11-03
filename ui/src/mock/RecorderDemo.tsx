// Mock mode only (/dev/recorder): drives the voice-over recorder (ui/src/recorder) on its own, for development and
// the Playwright spec, which supplies the mic through window.__vaTestMic. Never in production builds: App.tsx mounts
// it only when VITE_MOCK is set.
import { Button, Code, Group, Stack, Text, Title } from '@mantine/core'
import { useRef, useState } from 'react'
import { SAMPLE_RATE } from '../../../src/lib/timeline'
import { createRecorder, type RecordedTake, type Recorder } from '../recorder/recorder'

export default function RecorderDemo() {
  const rec = useRef<Recorder | null>(null)
  const [phase, setPhase] = useState<'idle' | 'opening' | 'recording' | 'stopping'>('idle')
  const [level, setLevel] = useState(0)
  const [captured, setCaptured] = useState(0)
  const [take, setTake] = useState<RecordedTake | null>(null)
  const [error, setError] = useState<string | null>(null)

  const record = async () => {
    setError(null)
    setTake(null)
    setPhase('opening')
    try {
      const r = await createRecorder({
        echoCancellation: false,
        owner: { userId: 'demo', draftId: null, expectedRev: null, scopeJobId: null },
        onLevel: (l) => setLevel(l.peak),
        onProgress: (p) => setCaptured(p.samples),
      })
      rec.current = r
      r.start()
      setPhase('recording')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    }
  }

  const stop = async () => {
    const r = rec.current
    if (!r) return
    setPhase('stopping')
    try {
      const t = await r.stop()
      // For the spec: the WAV itself, so it can hash it independently.
      ;(window as unknown as { __vaTake?: RecordedTake }).__vaTake = t
      setTake(t)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    rec.current = null
    setPhase('idle')
  }

  return (
    <Stack gap="md">
      <div>
        <Title order={1}>Recorder</Title>
        <Text size="sm" c="var(--va-muted)">
          The voice-over recorder on its own (mock data).
        </Text>
      </div>
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
