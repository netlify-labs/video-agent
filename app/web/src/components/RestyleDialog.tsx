// Restyle (plan 2026-11-04-looks §4.3, §6): a revision with another look. It's a full run, often on someone else's
// video, so the dialog says it makes a new version and what the last run cost. Hidden for recorded narration (the
// server refuses it too, 409 look_not_allowed, shown inline when a stale page gets that far).
import { Alert, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { $api, errorMessage, newIdempotencyKey, type Version, type Video } from '../api/client'
import { credits } from './bits'
import { LookPicker, useLooks } from './LookPicker'

/** Whether Restyle is offered for a version: ready, looks on, and no recorded narration. */
export const canRestyle = (v: Version, looksOn: boolean) =>
  looksOn && v.status === 'ready' && !v.links.narrationAudio

const restylePrompt = (name: string | null) =>
  name ? `Restyle this video in the ${name} look.` : 'Restyle this video without a look.'

export function RestyleDialog(props: {
  video: Video
  version: Version
  opened: boolean
  onClose: () => void
}) {
  const { video, version: v } = props
  const looks = useLooks()
  const qc = useQueryClient()
  const phone = useMediaQuery('(max-width: 48em)')
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  const [prompt, setPrompt] = useState('')
  const [key] = useState(newIdempotencyKey)
  const revise = $api.useMutation('post', '/api/v1/videos/{id}/versions', {
    onSuccess: () => {
      void qc.invalidateQueries()
      props.onClose()
    },
  })
  const spent = v.usage?.totalCreditsCost
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title={`Restyle v${v.n}`}
      size="min(1200px, 94vw)"
      fullScreen={phone}
      closeButtonProps={{ 'aria-label': 'Close' }}
      centered
    >
      <Stack gap="md">
        <Text size="sm" c="var(--va-muted)">
          {v.look ? `v${v.n} uses the ${v.look.name} look.` : `v${v.n} has no look.`} Pick another; everything
          else stays as it is.
        </Text>
        {looks ? (
          <LookPicker
            looks={looks.looks}
            value={picked}
            current={v.look}
            onPick={(id) => {
              setPicked(id)
              setPrompt(restylePrompt(id ? (looks.looks.find((l) => l.id === id)?.name ?? id) : null))
            }}
          />
        ) : (
          <Text size="sm">Loading looks…</Text>
        )}
        {picked !== undefined ? (
          <Textarea
            label="Anything else?"
            autosize
            minRows={2}
            maxLength={4000}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.currentTarget.value)
            }}
          />
        ) : null}
        {revise.error ? (
          <Alert color="red" title="Couldn't restyle" data-testid="restyle-error">
            {errorMessage(revise.error)}
          </Alert>
        ) : null}
        <Text size="sm" c="var(--va-faint)" data-testid="restyle-cost">
          This makes a new version (a full run).
          {spent != null ? ` v${v.n} took ${credits(spent)} credits.` : ''}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={picked === undefined || prompt.trim().length < 3}
            loading={revise.isPending}
            onClick={() => {
              revise.mutate({
                params: { path: { id: video.id }, header: { 'idempotency-key': key } },
                body: { prompt, fromVersion: v.n, look: picked ?? null },
              })
            }}
          >
            Make v{video.versions.length + 1}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
