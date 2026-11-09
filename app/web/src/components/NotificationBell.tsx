// App-wide notifications (plan v2 §3, §14 rule 13): comments and approvals on your videos. Polls while the tab is
// visible, independent of run polling; opening the menu marks everything read.
import { ActionIcon, Indicator, Menu, Text } from '@mantine/core'
import { useQueryClient } from '@tanstack/react-query'
import { IconBell } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { $api } from '../api/client'
import { relativeTime } from './bits'

export function NotificationBell() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const feed = $api.useQuery(
    'get',
    '/api/v1/notifications',
    { params: { query: { limit: 15 } } },
    { refetchInterval: 30_000, refetchIntervalInBackground: false },
  )
  const read = $api.useMutation('post', '/api/v1/notifications/read', {
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['get', '/api/v1/notifications'] }),
  })
  const unread = feed.data?.unreadCount ?? 0

  // A browser notification for new items, when the person allowed notifications (from a video page).
  const seen = useRef<string | null>(null)
  useEffect(() => {
    const newest = feed.data?.items[0]
    if (!newest) return
    if (seen.current !== null && newest.id !== seen.current && newest.unread) {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(newest.summary)
    }
    seen.current = newest.id
  }, [feed.data])

  return (
    <Menu
      position="bottom-end"
      width={340}
      onOpen={() => {
        if (unread > 0) read.mutate({ body: {} })
      }}
    >
      <Menu.Target>
        <Indicator label={unread > 99 ? '99+' : unread} size={16} disabled={unread === 0} offset={4}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
          >
            <IconBell size={18} />
          </ActionIcon>
        </Indicator>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Comments and approvals on your videos</Menu.Label>
        {(feed.data?.items ?? []).length === 0 ? (
          <Text size="sm" c="var(--va-faint)" px="sm" py="xs">
            Nothing yet.
          </Text>
        ) : (
          feed.data?.items.map((n) => (
            <Menu.Item
              key={n.id}
              onClick={() => void navigate(`/videos/${n.video.id}`)}
              style={{ fontWeight: n.unread ? 600 : 400 }}
            >
              <Text size="sm" lineClamp={2}>
                {n.summary}
              </Text>
              <Text size="xs" c="var(--va-faint)">
                {n.video.title} · {relativeTime(n.createdAt)}
              </Text>
            </Menu.Item>
          ))
        )}
      </Menu.Dropdown>
    </Menu>
  )
}
