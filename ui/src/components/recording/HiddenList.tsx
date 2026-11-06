// A demo on the video page (screen-recording plan §8.1; va-rsk5.4.3): "Made from a recording" with what the run made
// of it, and the Hidden list: every hidden area per scene, why it's hidden, and who checked it. Looks right marks the
// unchecked ones checked (POST .../hidden/confirm). Hiding is cosmetic: the note says so.
import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconEyeOff } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { $api, errorMessage, type Version, type Video } from '../../api/client'

const mss = (s: number) => `${String(Math.floor(s / 60))}:${String(Math.round(s % 60)).padStart(2, '0')}`

/** The hidden areas nobody has checked yet that Video Agent added (what Looks right is for). */
export const uncheckedAgentAreas = (v: Version) => [
  ...new Set(
    (v.recording?.hidden ?? []).filter((h) => h.source === 'agent' && !h.checkedBy).map((h) => h.id),
  ),
]

/** The note Make public and Publish repeat for a demo. */
export const COSMETIC_NOTE =
  'Hidden areas cover the picture in the video; people who can open this video can still watch the full recording.'

export function HiddenList({ video, v, canCheck }: { video: Video; v: Version; canCheck: boolean }) {
  const qc = useQueryClient()
  const rec = v.recording
  const confirm = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/hidden/confirm', {
    onSuccess: () => {
      void qc.invalidateQueries()
    },
    onError: (e) =>
      notifications.show({ color: 'red', title: "Couldn't mark them checked", message: errorMessage(e) }),
  })
  if (!rec) return null
  const s = rec.summary
  const ids = [...new Set(rec.hidden.filter((h) => !h.checkedBy).map((h) => h.id))]
  const byScene = new Map<string, typeof rec.hidden>()
  for (const h of rec.hidden) byScene.set(h.beat, [...(byScene.get(h.beat) ?? []), h])
  return (
    <Card data-testid="hidden-list">
      <Stack gap="xs">
        <Text fw={600}>Made from a recording</Text>
        {s ? (
          <Text size="sm" c="var(--va-muted)" data-testid="recording-summary">
            {mss(s.sourceSec)} recording: {String(s.steps)} {s.steps === 1 ? 'scene' : 'scenes'},{' '}
            {mss(s.cutSec)} cut, {String(rec.hidden.length ? new Set(rec.hidden.map((h) => h.id)).size : 0)}{' '}
            areas hidden
          </Text>
        ) : null}
        {rec.hidden.length ? (
          [...byScene].map(([beat, areas]) => (
            <Stack key={beat} gap={4}>
              <Text size="xs" fw={600} c="var(--va-muted)">
                {beat}
              </Text>
              {areas.map((h) => (
                <Group key={`${h.id}@${beat}`} gap="xs" wrap="nowrap" data-testid="hidden-entry">
                  <IconEyeOff size={14} />
                  <Text size="sm" style={{ flex: 1 }}>
                    {h.why}
                  </Text>
                  <Text size="xs" c="var(--va-muted)" className="num">
                    {mss(h.start)}–{mss(h.end)}
                  </Text>
                  {h.checkedBy ? (
                    <Badge size="xs" variant="light" color="green">
                      Checked
                    </Badge>
                  ) : null}
                </Group>
              ))}
            </Stack>
          ))
        ) : (
          <Text size="sm" c="var(--va-muted)">
            Nothing is hidden.
          </Text>
        )}
        {canCheck && ids.length ? (
          <Button
            size="xs"
            variant="light"
            loading={confirm.isPending}
            onClick={() => {
              confirm.mutate({ params: { path: { id: video.id, n: v.n } }, body: { ids } })
            }}
          >
            Looks right
          </Button>
        ) : null}
        <Text size="xs" c="var(--va-faint)">
          {COSMETIC_NOTE}
        </Text>
      </Stack>
    </Card>
  )
}
