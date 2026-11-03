// The editor's offer to bring back takes that weren't saved (plan 2026-11-02 §5.1): one row per take, with when it
// was recorded, how long it is and why it wasn't saved, and Recover / Discard. Renders nothing when there are none.
import { Alert, Button, Group, Stack, Text } from '@mantine/core'
import { useState } from 'react'
import { SAMPLE_RATE } from '../../../src/lib/timeline'
import type { TakeRecord } from './store'

const duration = (samples: number) => {
  const s = Math.round(samples / SAMPLE_RATE)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const why = (t: TakeRecord) =>
  t.status === 'recording'
    ? 'recording was interrupted'
    : t.upload.state === 'failed'
      ? (t.upload.error ?? "it didn't upload")
      : t.upload.mediaId
        ? "uploaded, but the draft wasn't saved"
        : 'not uploaded yet'

export function RecoveryPrompt({
  takes,
  onRecover,
  onDiscard,
}: {
  takes: TakeRecord[]
  onRecover: (t: TakeRecord) => Promise<unknown>
  onDiscard: (t: TakeRecord) => Promise<unknown>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!takes.length) return null
  const act = async (t: TakeRecord, f: (t: TakeRecord) => Promise<unknown>) => {
    setBusy(t.id)
    setError(null)
    try {
      await f(t)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Alert
      color="blue"
      variant="light"
      mb="md"
      title={takes.length === 1 ? 'An unsaved recording' : `${takes.length} unsaved recordings`}
      data-testid="recovery-prompt"
    >
      <Stack gap="xs">
        {takes.map((t) => (
          <Group key={t.id} justify="space-between" gap="sm" data-testid={`recovery-${t.id}`}>
            <Text size="sm">
              {new Date(t.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
              {duration(t.samples)} · {why(t)}
            </Text>
            <Group gap="xs">
              <Button
                size="xs"
                variant="default"
                disabled={busy !== null}
                onClick={() => void act(t, onDiscard)}
                aria-label={`Discard the recording from ${new Date(t.createdAt).toLocaleTimeString()}`}
              >
                Discard
              </Button>
              <Button
                size="xs"
                loading={busy === t.id}
                disabled={busy !== null && busy !== t.id}
                onClick={() => void act(t, onRecover)}
                aria-label={`Recover the recording from ${new Date(t.createdAt).toLocaleTimeString()}`}
              >
                Recover
              </Button>
            </Group>
          </Group>
        ))}
        {error ? (
          <Text size="sm" c="red" role="alert">
            {error}
          </Text>
        ) : null}
      </Stack>
    </Alert>
  )
}
