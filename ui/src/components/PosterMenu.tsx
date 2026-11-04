// Picks a version's poster (src/domain/poster.ts): the frame you're on, an uploaded image, or back to the render's
// own (taken 30% of the way in). Above the player on the video page, and in the editor's header.
import { ActionIcon, Loader, Menu } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconPhoto, IconPhotoUp, IconRestore, IconScreenshot } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { $api, type Version } from '../api/client'
import { frameFiles, imageFiles, type PosterFiles } from '../lib/poster'
import { clockTime, fileUrl, showError } from './bits'

export function PosterMenu({
  videoId,
  v,
  dimensions,
  time,
  frameDisabled,
  size = 36,
}: {
  videoId: string
  v: Version
  dimensions: { width: number; height: number }
  /** The moment to use, read when the menu item is chosen (the player's or the editor's playhead). */
  time: () => number
  /** Why "Use this frame" can't be used here, if it can't. */
  frameDisabled?: string | undefined
  /** The button's size: 36 above the player, 30 in the editor's header. */
  size?: number
}) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const set = $api.useMutation('put', '/api/v1/videos/{id}/versions/{n}/poster')
  const reset = $api.useMutation('delete', '/api/v1/videos/{id}/versions/{n}/poster')
  const path = { params: { path: { id: videoId, n: v.n } } }

  const send = async (source: 'frame' | 'upload', make: () => Promise<PosterFiles>, second?: number) => {
    setBusy(true)
    try {
      const files = await make()
      await set.mutateAsync({
        ...path,
        body: { source, ...(second === undefined ? {} : { at: second }), ...files },
      })
      await qc.invalidateQueries()
      notifications.show({
        message:
          source === 'frame'
            ? `The poster for v${v.n} is now the frame at ${clockTime(second ?? 0)}.`
            : `The poster for v${v.n} is now your image.`,
      })
    } catch (e) {
      showError(e)
    } finally {
      setBusy(false)
    }
  }

  const current = v.poster
    ? v.poster.source === 'frame'
      ? `Poster: the frame at ${clockTime(v.poster.at ?? 0)}`
      : 'Poster: an uploaded image'
    : 'Poster: the frame 30% in (default)'
  return (
    <>
      <Menu
        position="bottom-end"
        onOpen={() => {
          setAt(time())
        }}
      >
        <Menu.Target>
          <ActionIcon
            variant="default"
            size={size}
            radius="md"
            aria-label="Poster"
            title={current}
            disabled={busy}
            data-custom={v.poster ? 'true' : undefined}
          >
            {busy ? <Loader size={16} /> : <IconPhoto size={size === 36 ? 18 : 16} />}
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{current}</Menu.Label>
          <Menu.Item
            leftSection={<IconScreenshot size={14} />}
            disabled={Boolean(frameDisabled)}
            title={frameDisabled}
            onClick={() => {
              void send('frame', () => frameFiles(fileUrl(videoId, v.n, 'video'), at, dimensions), at)
            }}
          >
            Use this frame ({clockTime(at)})
          </Menu.Item>
          {frameDisabled ? (
            <Menu.Label style={{ whiteSpace: 'normal', maxWidth: 260 }}>{frameDisabled}</Menu.Label>
          ) : null}
          <Menu.Item
            leftSection={<IconPhotoUp size={14} />}
            onClick={() => {
              input.current?.click()
            }}
          >
            Upload an image…
          </Menu.Item>
          {v.poster ? (
            <Menu.Item
              leftSection={<IconRestore size={14} />}
              onClick={() => {
                setBusy(true)
                reset.mutate(path, {
                  onSuccess: () => {
                    void qc.invalidateQueries().finally(() => {
                      setBusy(false)
                    })
                  },
                  onError: (e) => {
                    setBusy(false)
                    showError(e)
                  },
                })
              }}
            >
              Reset to default
            </Menu.Item>
          ) : null}
        </Menu.Dropdown>
      </Menu>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        hidden
        data-testid="poster-file"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (file) void send('upload', () => imageFiles(file, dimensions))
        }}
      />
    </>
  )
}
