// The end of a paged list: loads the next page on its own once it scrolls within reach, and keeps a Show more button
// for keyboards, old browsers and retrying after an error (when it stops loading on its own, so a failing page isn't
// fetched in a loop).
import { Button, Center } from '@mantine/core'
import { useEffect, useRef } from 'react'

export function LoadMore(props: {
  hasMore: boolean
  loading: boolean
  failed?: boolean
  onMore: () => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const more = useRef(props.onMore)
  more.current = props.onMore
  const auto = props.hasMore && !props.loading && props.failed !== true

  useEffect(() => {
    const el = end.current
    if (!auto || !el || typeof IntersectionObserver === 'undefined') return
    // A fresh observer reports at once, so a page that still doesn't fill the screen loads the next one too.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          more.current()
        }
      },
      { rootMargin: '0px 0px 600px 0px' },
    )
    io.observe(el)
    return () => {
      io.disconnect()
    }
  }, [auto])

  if (!props.hasMore) return null
  return (
    <Center mt="xl" ref={end} data-testid="load-more">
      <Button variant="default" loading={props.loading} onClick={props.onMore}>
        Show more
      </Button>
    </Center>
  )
}
