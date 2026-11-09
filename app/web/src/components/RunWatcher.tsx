// Tells the person when a run they asked about ends (the Notify button on the video page), wherever they are in the
// app and with the tab in the background: each watched video is polled until its run ends, then gets one browser
// notification, plus an in-app one when they're on another page (the video page shows its own). See lib/run-notify.ts.
import { notifications } from '@mantine/notifications'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { $api, videoInit } from '../api/client'
import {
  doneMessage,
  runEnded,
  showRunNotification,
  subscribeWatches,
  unwatchRun,
  watchSnapshot,
} from '../lib/run-notify'

export function RunWatcher() {
  const ids = useSyncExternalStore(subscribeWatches, watchSnapshot, () => '')
  return (
    <>
      {ids
        .split(',')
        .filter(Boolean)
        .map((id) => (
          <WatchOne key={id} id={id} />
        ))}
    </>
  )
}

function WatchOne({ id }: { id: string }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const here = useRef(pathname)
  here.current = pathname
  // The video page's own query (same key), so this adds no requests when both are open; it keeps polling while the
  // tab is hidden, which the page's doesn't.
  const video = $api.useQuery('get', '/api/v1/videos/{id}', videoInit(id), {
    refetchInterval: (q) => (q.state.data && runEnded(q.state.data.status) ? false : 5000),
    refetchIntervalInBackground: true,
  })
  const done = useRef(false)
  const data = video.data
  const code = (video.error as { error?: { code?: string } } | null)?.error?.code
  const gone = code === 'not_found' || code === 'forbidden'
  useEffect(() => {
    // Deleted, or no longer shared with this person: nothing to tell.
    if (gone) unwatchRun(id)
  }, [gone, id])
  useEffect(() => {
    if (!data || done.current || !runEnded(data.status)) return
    done.current = true
    unwatchRun(id)
    const url = `/videos/${id}`
    const msg = doneMessage(data.title, data.status)
    void showRunNotification(msg, url, () => void navigate(url))
    if (here.current !== url) {
      notifications.show({
        color: data.status === 'ready' ? 'teal' : 'red',
        message: msg,
        style: { cursor: 'pointer' },
        onClick: () => void navigate(url),
      })
    }
  }, [data, id, navigate])
  return null
}
