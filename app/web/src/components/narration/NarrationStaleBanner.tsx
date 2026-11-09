// The stale-base banner (plan 2026-11-02 §2.7): a newer version changed the narration since this draft's base.
// "Narration changed in v7 (Sam, 10 min ago)" with Rebase onto v7 (your narration moves onto your draft of v7,
// rechecked there) or Keep mine (render yours; the render dialog warns with keepMineWarning).
import { Alert, Button, Group, Text } from '@mantine/core'

export interface NarrationChanged {
  inVersion: number
  by: { userId: string; name: string }
  at: string
  yoursReplaces: boolean
}

/** "just now", "10 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string, now = Date.now()) {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

/** The render dialog's warning after Keep mine, or null when rendering replaces nothing. */
export function keepMineWarning(c: NarrationChanged | null) {
  return c?.yoursReplaces
    ? `Rendering this draft replaces the narration ${c.by.name} put in v${c.inVersion}.`
    : null
}

export interface NarrationStaleBannerProps {
  changed: NarrationChanged | null
  onRebase: (toN: number) => void
  onKeepMine: () => void
  busy?: boolean
  /** For tests: "now" for the relative time. */
  now?: number
}

export function NarrationStaleBanner({
  changed,
  onRebase,
  onKeepMine,
  busy = false,
  now,
}: NarrationStaleBannerProps) {
  if (!changed) return null
  return (
    <Alert color="blue" variant="light" role="status" data-testid="narration-stale-banner">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Text size="sm">
          Narration changed in v{changed.inVersion} ({changed.by.name}, {ago(changed.at, now)})
        </Text>
        {/* Without narration of its own the draft has nothing to rebase or keep: the note is enough. */}
        {changed.yoursReplaces ? (
          <Group gap="xs">
            <Button size="xs" onClick={() => onRebase(changed.inVersion)} loading={busy}>
              Rebase onto v{changed.inVersion}
            </Button>
            <Button size="xs" variant="default" onClick={onKeepMine} disabled={busy}>
              Keep mine
            </Button>
          </Group>
        ) : null}
      </Group>
    </Alert>
  )
}
