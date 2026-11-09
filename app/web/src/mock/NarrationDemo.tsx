// Mock mode only (/dev/narration): the Narration track's collaboration chrome on a mock draft, for development and
// the Playwright specs: the soft lock (banner, Take over, the taken-over notice) gating Record and save, and the
// stale-base banner (Rebase, or Keep mine and the render dialog's warning). Never in production builds: App.tsx mounts
// it only when VITE_MOCK is set.
import { Button, Group, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState } from 'react'
import { fetchClient } from '../api/client'
import {
  keepMineWarning,
  NarrationLockBanner,
  NarrationStaleBanner,
  useNarrationLock,
  type NarrationChanged,
} from '../components/narration'

const VIDEO = 'vid_teaser'

export default function NarrationDemo() {
  const [draftId, setDraftId] = useState<string | null>(null)
  const [baseN, setBaseN] = useState(2)
  const [changed, setChanged] = useState<NarrationChanged | null>(null)
  const [keptMine, setKeptMine] = useState(false)
  const [busy, setBusy] = useState(false)
  const [watching, setWatching] = useState(false)
  useEffect(() => {
    void fetchClient
      .POST('/api/v1/videos/{id}/versions/{n}/edits', { params: { path: { id: VIDEO, n: 2 } } })
      .then(({ data }) => {
        setDraftId(data?.id ?? null)
        setChanged(data?.narrationChanged ?? null)
      })
  }, [])
  const rebase = async (toN: number) => {
    if (!draftId) return
    setBusy(true)
    const { data } = await fetchClient.POST('/api/v1/edits/{id}/rebase-narration', {
      params: { path: { id: draftId } },
      body: { toN },
    })
    setBusy(false)
    if (!data) return
    setDraftId(data.id)
    setBaseN(data.baseN)
    setChanged(data.narrationChanged)
  }
  const warning = keptMine ? keepMineWarning(changed) : null
  const lock = useNarrationLock(VIDEO, draftId)
  return (
    <Stack gap="md">
      <div>
        <Title order={1}>Narration</Title>
        <Text size="sm" c="var(--va-muted)">
          The narration lock and stale-base banners on a mock draft.
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
      {keptMine ? null : (
        <NarrationStaleBanner
          changed={changed}
          busy={busy}
          onRebase={(n) => void rebase(n)}
          onKeepMine={() => setKeptMine(true)}
        />
      )}
      {warning ? (
        <Text size="sm" c="orange" data-testid="render-warning">
          {warning}
        </Text>
      ) : null}
      <Group gap="xs">
        <Button size="sm" disabled={!lock.canEdit}>
          Record
        </Button>
        <Button size="sm" variant="default" disabled={!lock.canEdit}>
          Save
        </Button>
      </Group>
      <Text size="sm" data-testid="narration-lock-status">
        {lock.state.status} · draft on v{baseN}
        {watching ? ' · watching the last rendered version' : ''}
      </Text>
    </Stack>
  )
}
