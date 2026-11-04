import { ActionIcon, Tooltip, UnstyledButton } from '@mantine/core'
import { IconStar, IconStarFilled } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { $api } from '../api/client'
import { showError } from './bits'

/** Stars or unstars a video in your own library. Shows the new state at once; reverts if the request fails. */
function useFavorite(videoId: string, favorite: boolean) {
  const qc = useQueryClient()
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const star = $api.useMutation('put', '/api/v1/videos/{id}/favorite')
  const unstar = $api.useMutation('delete', '/api/v1/videos/{id}/favorite')
  const on = optimistic ?? favorite
  const toggle = () => {
    const next = !on
    setOptimistic(next)
    ;(next ? star : unstar).mutate(
      { params: { path: { id: videoId } } },
      {
        onSuccess: () => {
          void qc.invalidateQueries().finally(() => {
            setOptimistic(null)
          })
        },
        onError: (e) => {
          setOptimistic(null)
          showError(e)
        },
      },
    )
  }
  return { on, toggle }
}

/** The star over a library tile's poster. It sits beside the tile's link, not inside it. */
export function FavoriteStar({ videoId, favorite }: { videoId: string; favorite: boolean }) {
  const { on, toggle } = useFavorite(videoId, favorite)
  const label = on ? 'Remove from favorites' : 'Add to favorites'
  return (
    <Tooltip label={label} openDelay={400}>
      <UnstyledButton
        className="va-fav"
        data-on={on ? 'true' : undefined}
        aria-label={label}
        aria-pressed={on}
        onClick={toggle}
      >
        {on ? <IconStarFilled size={16} /> : <IconStar size={16} />}
      </UnstyledButton>
    </Tooltip>
  )
}

/** The favorite star above a video page's player. */
export function FavoriteButton({ videoId, favorite }: { videoId: string; favorite: boolean }) {
  const { on, toggle } = useFavorite(videoId, favorite)
  const label = on ? 'Remove from favorites' : 'Add to favorites'
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant="default"
        size={36}
        radius="md"
        aria-label={label}
        title={label}
        aria-pressed={on}
        onClick={toggle}
      >
        {on ? <IconStarFilled size={18} color="var(--va-star)" /> : <IconStar size={18} />}
      </ActionIcon>
    </Tooltip>
  )
}
