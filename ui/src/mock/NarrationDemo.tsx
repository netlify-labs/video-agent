// Mock mode only (/dev/narration): the Narration track's collaboration chrome on a mock draft, for development and
// the Playwright spec: the soft lock (banner, Take over, the taken-over notice) gating Record and save. Never in
// production builds: App.tsx mounts it only when VITE_MOCK is set.
import { Button, Group, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState } from 'react'
import { fetchClient } from '../api/client'
import { NarrationLockBanner, useNarrationLock } from '../components/narration'

const VIDEO = 'vid_teaser'

export default function NarrationDemo() {
  const [draftId, setDraftId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [watching, setWatching] = useState(false)
  useEffect(() => {
    void fetchClient
      .POST('/api/v1/videos/{id}/versions/{n}/edits', { params: { path: { id: VIDEO, n: 2 } } })
      .then(({ data }) => setDraftId(data?.id ?? null))
  }, [])
  const lock = useNarrationLock(VIDEO, draftId)
  return (
    <Stack gap="md">
      <div>
        <Title order={1}>Narration</Title>
        <Text size="sm" c="var(--va-muted)">
          The narration lock on a mock draft.
        </Text>
      </div>
      <NarrationLockBanner
        state={lock.state}
        busy={busy}
        onWatch={() => setWatching(true)}
        onTakeOver={() => {
          setBusy(true)
          void lock.takeOver().finally(() => setBusy(false))
        }}
      />
      <Group gap="xs">
        <Button size="sm" disabled={!lock.canEdit}>
          Record
        </Button>
        <Button size="sm" variant="default" disabled={!lock.canEdit}>
          Save
        </Button>
      </Group>
      <Text size="sm" data-testid="narration-lock-status">
        {lock.state.status}
        {watching ? ' · watching the last rendered version' : ''}
      </Text>
    </Stack>
  )
}
