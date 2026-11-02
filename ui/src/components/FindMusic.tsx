// Find music on Openverse: search CC0 and CC BY tracks through the server, listen before importing, and import one into
// the library. Previews play the provider's file in one shared <audio>, one at a time, only when someone presses play.
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconPlayerPlayFilled, IconPlayerStopFilled, IconSearch } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { $api, errorMessage } from '../api/client'
import type { paths } from '../api/schema'
import { duration, type Media } from './MediaPicker'

type Search = paths['/api/v1/media/openverse/search']['get']
export type Track = Search['responses'][200]['content']['application/json']['items'][number]
type License = NonNullable<NonNullable<Search['parameters']['query']>['license']>
type Category = NonNullable<NonNullable<Search['parameters']['query']>['category']>

export function FindMusicModal(props: {
  opened: boolean
  onClose: () => void
  /** Called with the library item after an import (or when the track was already imported). */
  onImported?: (m: Media) => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [license, setLicense] = useState<License>('cc0,by')
  const [category, setCategory] = useState<Category>('music')
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const results = $api.useQuery(
    'get',
    '/api/v1/media/openverse/search',
    { params: { query: { q: query, license, category } } },
    { enabled: props.opened && query.length > 0, retry: false, staleTime: 5 * 60_000 },
  )
  const importIt = $api.useMutation('post', '/api/v1/media/openverse/import', {
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media'] })
      void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media/openverse/search'] })
      notifications.show({ message: `${m.source?.title ?? m.filename} is in the library.` })
      props.onImported?.(m)
    },
    onError: (e) => notifications.show({ color: 'red', message: errorMessage(e) }),
  })

  const stop = () => {
    audio.current?.pause()
    setPlaying(null)
  }
  // Closing the dialog stops any preview.
  useEffect(() => {
    if (!props.opened) stop()
  }, [props.opened])
  const toggle = (t: Track) => {
    const el = audio.current
    if (!el || !t.previewUrl) return
    if (playing === t.id) return stop()
    el.src = t.previewUrl
    setPlaying(t.id)
    el.play().catch((e: unknown) => {
      // Switching tracks interrupts the last play(); only a real failure of this one says so.
      if (e instanceof DOMException && e.name === 'AbortError') return
      setPlaying((p) => (p === t.id ? null : p))
      notifications.show({ color: 'red', message: "This preview couldn't play." })
    })
  }

  const items = results.data?.items ?? []
  return (
    <Modal opened={props.opened} onClose={props.onClose} title="Find music on Openverse" size="lg">
      <Stack gap="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            stop()
            setQuery(draft.trim())
          }}
        >
          <Group gap="xs" wrap="nowrap">
            <TextInput
              flex={1}
              aria-label="Search music"
              placeholder="Calm piano, upbeat electronic, cinematic…"
              value={draft}
              maxLength={200}
              onChange={(e) => {
                setDraft(e.currentTarget.value)
              }}
              data-autofocus
            />
            <Button type="submit" leftSection={<IconSearch size={16} />} disabled={!draft.trim()}>
              Search
            </Button>
          </Group>
        </form>
        <Group gap="xs" justify="space-between">
          <SegmentedControl
            size="xs"
            aria-label="Licence"
            value={license}
            onChange={(v) => {
              setLicense(v)
            }}
            data={[
              { value: 'cc0,by', label: 'CC0 + CC BY' },
              { value: 'cc0', label: 'CC0 only' },
            ]}
          />
          <SegmentedControl
            size="xs"
            aria-label="Kind"
            value={category}
            onChange={(v) => {
              setCategory(v)
            }}
            data={[
              { value: 'music', label: 'Music' },
              { value: 'sound_effect', label: 'Effects' },
              { value: 'all', label: 'All audio' },
            ]}
          />
        </Group>
        <Text size="xs" c="var(--va-faint)">
          Only CC0 and CC BY tracks: free for commercial videos and edits. CC BY tracks are credited on the
          video, its share page and the embed.
        </Text>
        <audio
          ref={audio}
          preload="none"
          onEnded={() => {
            setPlaying(null)
          }}
          hidden
        />
        {results.error ? (
          <Text size="sm" c="red" data-testid="openverse-error">
            {errorMessage(results.error)}
          </Text>
        ) : results.isFetching ? (
          <Text size="sm" c="var(--va-muted)">
            Searching…
          </Text>
        ) : query && items.length === 0 ? (
          <Text size="sm" c="var(--va-muted)">
            No tracks found. Try other words.
          </Text>
        ) : (
          <Stack gap={6} className="va-openverse-list">
            {items.map((t) => (
              <Group
                key={t.id}
                wrap="nowrap"
                gap="sm"
                className="va-openverse-row"
                data-testid={`track-${t.id}`}
              >
                <ActionIcon
                  variant={playing === t.id ? 'filled' : 'default'}
                  radius="xl"
                  size="lg"
                  disabled={!t.previewUrl}
                  aria-label={`${playing === t.id ? 'Stop' : 'Play'} ${t.title}`}
                  aria-pressed={playing === t.id}
                  onClick={() => {
                    toggle(t)
                  }}
                  data-testid={`preview-${t.id}`}
                >
                  {playing === t.id ? <IconPlayerStopFilled size={14} /> : <IconPlayerPlayFilled size={14} />}
                </ActionIcon>
                <Stack gap={0} flex={1} miw={0}>
                  <Text size="sm" fw={600} truncate title={t.title}>
                    {t.landingUrl ? (
                      <Anchor href={t.landingUrl} target="_blank" rel="noopener" c="inherit">
                        {t.title}
                      </Anchor>
                    ) : (
                      t.title
                    )}
                  </Text>
                  <Text size="xs" c="var(--va-muted)" truncate>
                    {[
                      t.creator,
                      t.durationSec ? duration(t.durationSec) : null,
                      t.genres.slice(0, 2).join(', '),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </Stack>
                <Badge
                  size="sm"
                  variant="light"
                  color={t.license === 'cc0' ? 'teal' : 'blue'}
                  title={t.license === 'by' ? 'Credit required (added automatically)' : 'No credit needed'}
                >
                  {t.licenseLabel}
                </Badge>
                {t.mediaId ? (
                  <Badge size="sm" variant="outline" color="gray">
                    In library
                  </Badge>
                ) : (
                  <Button
                    size="compact-sm"
                    variant="default"
                    disabled={!t.importable || (importIt.isPending && importIt.variables.body.id !== t.id)}
                    loading={importIt.isPending && importIt.variables.body.id === t.id}
                    title={
                      t.importable
                        ? undefined
                        : "This track's file doesn't fit the library (type, size or length)."
                    }
                    onClick={() => {
                      importIt.mutate({ body: { id: t.id } })
                    }}
                  >
                    Import
                  </Button>
                )}
              </Group>
            ))}
          </Stack>
        )}
        <Text size="xs" c="var(--va-faint)">
          Search by{' '}
          <Anchor href="https://openverse.org" target="_blank" rel="noopener" size="xs" c="var(--va-muted)">
            Openverse
          </Anchor>
          . Previews play from the track’s source site.
        </Text>
      </Stack>
    </Modal>
  )
}
