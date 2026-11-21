// Find another ElevenLabs voice: search ElevenLabs' voice library through the server, listen to each voice's own
// sample (one at a time, only when someone presses play), and add one to the deployment's ElevenLabs account so
// voice-overs can use it. The added voice then shows in the voice picker for everyone.
import { ActionIcon, Badge, Button, Group, Loader, Modal, Stack, Text, TextInput } from '@mantine/core'
import { IconPlayerPlayFilled, IconPlayerStopFilled, IconSearch } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { errorMessage, fetchClient } from '../api/client'
import type { paths } from '../api/schema'
import { showError } from './bits'

type Result = paths['/api/v1/voices/library']['get']['responses'][200]['content']['application/json']
export type LibraryVoice = Result['items'][number]

async function search(q: string, page: number): Promise<Result> {
  const { data, error } = await fetchClient.GET('/api/v1/voices/library', {
    params: { query: { ...(q ? { q } : {}), page } },
  })
  if (!data) throw new Error(errorMessage(error))
  return data
}

export function FindVoiceModal(props: {
  opened: boolean
  onClose: () => void
  /** Called with the added voice's id, once it is in the account. */
  onPicked: (voice: string) => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [pages, setPages] = useState(1)
  const [adding, setAdding] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)

  const results = useQuery({
    queryKey: ['voice-library', q, pages],
    enabled: props.opened,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      // Every page so far, in order.
      const all: Result[] = []
      for (let page = 1; page <= pages; page++) all.push(await search(q, page))
      return { items: all.flatMap((r) => r.items), hasMore: all.at(-1)?.hasMore ?? false }
    },
  })

  const stop = () => {
    audio.current?.pause()
    audio.current = null
    setPlaying(null)
  }
  // Closing the finder stops the sample.
  useEffect(() => {
    if (!props.opened) {
      audio.current?.pause()
      audio.current = null
      setPlaying(null)
    }
  }, [props.opened])

  const toggle = (v: LibraryVoice) => {
    const was = playing
    stop()
    if (was === v.id || !v.previewUrl) return
    const a = new Audio(v.previewUrl)
    a.onended = () => {
      setPlaying((p) => (p === v.id ? null : p))
    }
    audio.current = a
    setPlaying(v.id)
    void a.play().catch(() => {
      setPlaying(null)
    })
  }

  const add = async (v: LibraryVoice) => {
    setAdding(v.id)
    try {
      const { data, error } = await fetchClient.POST('/api/v1/voices', {
        body: { ownerId: v.ownerId, voiceId: v.id, name: v.name.slice(0, 80) },
      })
      if (!data) throw new Error(errorMessage(error))
      await qc.invalidateQueries({ queryKey: ['get', '/api/v1/voices'] })
      void qc.invalidateQueries({ queryKey: ['voice-library'] })
      stop()
      props.onPicked(data.id)
      props.onClose()
    } catch (e) {
      showError(e)
    } finally {
      setAdding(null)
    }
  }

  const items = results.data?.items ?? []
  return (
    <Modal opened={props.opened} onClose={props.onClose} title="Find an ElevenLabs voice" size="lg">
      <Stack gap="sm" data-testid="find-voice">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setPages(1)
            setQ(text.trim())
          }}
        >
          <Group gap="xs" wrap="nowrap" align="end">
            <TextInput
              aria-label="Search voices"
              placeholder="calm British narrator, upbeat, deep…"
              leftSection={<IconSearch size={16} />}
              style={{ flex: 1, minWidth: 0 }}
              value={text}
              data-autofocus
              onChange={(e) => {
                setText(e.currentTarget.value)
              }}
            />
            <Button type="submit" variant="default" style={{ flexShrink: 0 }}>
              Search
            </Button>
          </Group>
        </form>
        <Text size="xs" c="var(--va-faint)">
          {q ? `Voices matching “${q}”, most used first.` : "ElevenLabs' most used voices."} Using one adds it
          to this deployment&apos;s ElevenLabs voices.
        </Text>
        {results.isPending ? (
          <Group justify="center" py="lg">
            <Loader size="sm" />
          </Group>
        ) : results.isError ? (
          <Text size="sm" c="red" role="alert">
            {errorMessage(results.error)}
          </Text>
        ) : items.length === 0 ? (
          <Text size="sm" c="var(--va-muted)">
            No voices match. Try other words.
          </Text>
        ) : (
          <Stack gap={4}>
            {items.map((v) => (
              <Group key={v.id} gap="sm" wrap="nowrap" py={4} data-testid={`library-voice-${v.id}`}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  disabled={!v.previewUrl}
                  aria-label={playing === v.id ? `Stop ${v.name}` : `Hear ${v.name}`}
                  onClick={() => {
                    toggle(v)
                  }}
                >
                  {playing === v.id ? <IconPlayerStopFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
                </ActionIcon>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={500} truncate>
                    {v.name}
                  </Text>
                  {v.description ? (
                    <Text size="xs" c="var(--va-muted)" truncate>
                      {v.description}
                    </Text>
                  ) : null}
                </div>
                {v.added ? (
                  <Badge variant="light" color="gray">
                    In your voices
                  </Badge>
                ) : (
                  <Button
                    size="compact-sm"
                    variant="light"
                    loading={adding === v.id}
                    disabled={adding !== null && adding !== v.id}
                    onClick={() => {
                      void add(v)
                    }}
                  >
                    Use this voice
                  </Button>
                )}
              </Group>
            ))}
            {results.data.hasMore ? (
              <Button
                variant="subtle"
                color="gray"
                loading={results.isFetching}
                onClick={() => {
                  setPages((n) => n + 1)
                }}
              >
                Show more
              </Button>
            ) : null}
          </Stack>
        )}
      </Stack>
    </Modal>
  )
}
