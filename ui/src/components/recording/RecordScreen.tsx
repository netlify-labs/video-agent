// Record in the app (screen-recording plan §4.5, path B; va-rsk5.4.7): share a tab, window or screen and record it,
// encoded live (lib/screen-capture), so the file is ready to upload the moment it stops. Stops by itself when sharing
// ends in the browser or at the 5-minute limit.
import { Alert, Button, Group, Stack, Text } from '@mantine/core'
import { IconPlayerRecordFilled, IconPlayerStopFilled } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import {
  CaptureError,
  captureMode,
  captureSupport,
  MAX_SECONDS,
  startScreenRecording,
  type CaptureMode,
  type ScreenRecording,
} from '../../lib/screen-capture'

const clock = (s: number) => `${String(Math.floor(s / 60))}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function RecordScreen(props: { onRecorded: (f: File) => void; onCancel: () => void }) {
  const [mode, setMode] = useState<CaptureMode | null>(null)
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'finishing'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<ScreenRecording | null>(null)

  useEffect(() => {
    void captureSupport().then((s) => {
      setMode(captureMode(s))
    })
    return () => {
      rec.current?.cancel()
    }
  }, [])

  useEffect(() => {
    if (state !== 'recording') return
    const t = setInterval(() => {
      setElapsed(rec.current?.elapsed() ?? 0)
    }, 250)
    return () => {
      clearInterval(t)
    }
  }, [state])

  const finish = async () => {
    const r = rec.current
    if (!r) return
    setState('finishing')
    try {
      const file = await r.stop()
      rec.current = null
      props.onRecorded(file)
    } catch (e) {
      rec.current = null
      setState('idle')
      setError(e instanceof Error ? e.message : "The recording couldn't be finished.")
    }
  }

  const start = async () => {
    if (!mode || mode === 'unsupported') return
    setError(null)
    setState('starting')
    try {
      const r = await startScreenRecording(mode)
      rec.current = r
      setElapsed(0)
      setState('recording')
      void r.ended.then(() => {
        if (rec.current === r) void finish()
      })
    } catch (e) {
      setState('idle')
      setError(e instanceof CaptureError ? e.message : "The screen couldn't be recorded.")
    }
  }

  if (mode === 'unsupported')
    return (
      <Alert color="yellow" title="This browser can't record the screen here">
        Record with your system's screen recorder and upload the file instead.
      </Alert>
    )
  return (
    <Stack gap="sm" data-testid="record-screen">
      <Text size="sm" c="var(--va-muted)">
        Recordings made here don't include cursor data, so Video Agent will look for your cursor in the
        picture. Up to {String(MAX_SECONDS / 60)} minutes; keep this tab open until it's uploaded.
      </Text>
      {error ? (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      ) : null}
      {state === 'recording' || state === 'finishing' ? (
        <Group>
          <Text className="num" fw={600} aria-live="polite" data-testid="record-elapsed">
            <IconPlayerRecordFilled size={12} color="var(--mantine-color-red-6)" /> {clock(elapsed)} /{' '}
            {clock(MAX_SECONDS)}
          </Text>
          <Button
            leftSection={<IconPlayerStopFilled size={14} />}
            loading={state === 'finishing'}
            onClick={() => void finish()}
          >
            Stop recording
          </Button>
        </Group>
      ) : (
        <Group>
          <Button
            leftSection={<IconPlayerRecordFilled size={14} />}
            color="red"
            disabled={!mode}
            loading={state === 'starting'}
            onClick={() => void start()}
          >
            Choose what to record
          </Button>
          <Button variant="subtle" onClick={props.onCancel}>
            Back
          </Button>
        </Group>
      )}
    </Stack>
  )
}
