// The narration lock banner (plan 2026-11-02 §2.7): "Dana is editing the narration (since 14:02)" with Watch (audition
// the last rendered version, read-only) and Take over; or, once someone took it from you, "Sam took over the
// narration. Your draft is saved; you can render it or discard it." with Take it back. Nothing while you hold it.
import { Alert, Button, Group, Text } from '@mantine/core'
import { lockTime, type NarrationLockState } from './narration-lock'

export interface NarrationLockBannerProps {
  state: NarrationLockState
  onTakeOver: () => void
  /** Watch: play the last rendered version read-only. Hidden when there's nothing to watch. */
  onWatch?: (() => void) | undefined
  busy?: boolean
}

export function NarrationLockBanner({ state, onTakeOver, onWatch, busy = false }: NarrationLockBannerProps) {
  if (state.status === 'locked')
    return (
      <Alert color="yellow" variant="light" role="status" data-testid="narration-lock-banner">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Text size="sm">
            {state.holder
              ? `${state.holder.name} is editing the narration (since ${lockTime(state.holder.since)}).`
              : 'Someone is editing the narration.'}
          </Text>
          <Group gap="xs">
            {onWatch ? (
              <Button size="xs" variant="default" onClick={onWatch}>
                Watch
              </Button>
            ) : null}
            <Button size="xs" onClick={onTakeOver} loading={busy}>
              Take over
            </Button>
          </Group>
        </Group>
      </Alert>
    )
  if (state.status === 'taken_over')
    return (
      <Alert color="orange" variant="light" role="alert" data-testid="narration-lock-banner">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Text size="sm">
            {state.by.name} took over the narration. Your draft is saved; you can render it or discard it.
          </Text>
          <Button size="xs" variant="default" onClick={onTakeOver} loading={busy}>
            Take it back
          </Button>
        </Group>
      </Alert>
    )
  if (state.status === 'error')
    return (
      <Alert color="red" variant="light" role="alert" data-testid="narration-lock-banner">
        <Text size="sm">{state.message}</Text>
      </Alert>
    )
  return null
}
