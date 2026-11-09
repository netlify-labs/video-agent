// The person's yes for an agent's consequential action (spending credits, publishing, deleting). WebMCP has no consent
// step of its own yet, so a tool marked consequentialHint waits here until the person clicks; closing the dialog is a no.
import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import { useSyncExternalStore } from 'react'

export interface ConfirmRequest {
  /** What the agent wants to do, as a short action: "Create a video". */
  title: string
  /** What happens and what it costs, in plain words. */
  body: string
  /** The confirming button's label: "Create video". */
  action: string
}

interface Pending extends ConfirmRequest {
  resolve: (yes: boolean) => void
}

let pending: Pending | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

/**
 * Asks the person; resolves true only on their click. A request while another is open declines the newer one, and an
 * abort (the tool was unregistered, or the agent cancelled) closes the dialog as a no.
 */
export function confirmAction(req: ConfirmRequest, signal?: AbortSignal): Promise<boolean> {
  if (pending || signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const done = (yes: boolean) => {
      if (pending?.resolve !== done) return
      pending = null
      emit()
      resolve(yes)
    }
    pending = { ...req, resolve: done }
    signal?.addEventListener('abort', () => {
      done(false)
    })
    emit()
  })
}

/** The request waiting for the person, if any (the host renders it; tests answer it). */
export const pendingConfirm = (): (ConfirmRequest & { resolve: (yes: boolean) => void }) | null => pending

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Rendered once by the layout: the dialog for the request waiting, if any. */
export function WebMcpConfirmHost() {
  const req = useSyncExternalStore(subscribe, () => pending)
  return (
    <Modal
      opened={req !== null}
      onClose={() => req?.resolve(false)}
      title={req ? `An AI agent wants to: ${req.title}` : ''}
      centered
      data-testid="webmcp-confirm"
    >
      {req ? (
        <Stack gap="md">
          <Text size="sm">{req.body}</Text>
          <Text size="xs" c="var(--va-faint)">
            The request came from an AI agent in your browser, not from you. Only allow it if you asked for
            it.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => req.resolve(false)}>
              Don't allow
            </Button>
            <Button onClick={() => req.resolve(true)}>{req.action}</Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  )
}
