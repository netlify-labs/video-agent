// Find music on Openverse: search CC0 and CC BY tracks through the server, listen before importing, and import one into
// the library. Matching audio already in the library shows first, at once; Openverse's tracks follow. Previews play in
// one shared <audio>, one at a time, only when someone presses play. Searches are stored on the server, so common ones
// (the quick picks) answer at once; a stored one over a day old says when it was updated. Otherwise Openverse is often
// slow: then the server answers 202 with a job, which this polls (1 s, backing off to 3 s) for up to two minutes before
// offering Retry.
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Slider,
  Stack,
  Text,
  TextInput,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconExternalLink, IconPlayerPlayFilled, IconPlayerStopFilled, IconSearch } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { errorMessage, fetchClient } from '../api/client'
import type { paths } from '../api/schema'
import { MUSIC_SOURCES } from '../lib/music-sources'
import { relativeTime } from './bits'
import { duration, type Media } from './MediaPicker'

type Search = paths['/api/v1/media/openverse/search']['get']
type SearchResult = Search['responses'][200]['content']['application/json']
export type Track = SearchResult['items'][number]
type Job = paths['/api/v1/media/openverse/jobs/{id}']['get']['responses'][200]['content']['application/json']
type License = NonNullable<NonNullable<Search['parameters']['query']>['license']>
type Category = NonNullable<NonNullable<Search['parameters']['query']>['category']>

/** How long to wait for a slow Openverse before giving up (the job may still finish; Retry picks it up). */
const GIVE_UP_MS = 2 * 60_000
const TOO_SLOW = 'Openverse is taking too long to answer. Try again in a minute.'
/** Results older than this (stored on the server) say when they were fetched. */
const HOUR = 3600_000

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

/** Polls a job until it's done (backing off from 1 s to 3 s), failing with its error or after GIVE_UP_MS. */
async function finished(job: Job, signal?: AbortSignal): Promise<Job> {
  const started = Date.now()
  for (let delay = 1000; ; delay = Math.min(delay + 500, 3000)) {
    if (job.status === 'done') return job
    if (job.status === 'failed') throw new Error(job.error?.message ?? TOO_SLOW)
    if (Date.now() - started >= GIVE_UP_MS) throw new Error(TOO_SLOW)
    await wait(delay, signal)
    const r = await fetchClient.GET('/api/v1/media/openverse/jobs/{id}', {
      params: { path: { id: job.id } },
      ...(signal ? { signal } : {}),
    })
    if (r.error) throw new Error(errorMessage(r.error))
    job = r.data
  }
}

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
  // Where the playing preview is, for the timeline under its row.
  const [clock, setClock] = useState({ at: 0, length: 0 })
  // Set while the search waits on a background job (Openverse was slow).
  const [slow, setSlow] = useState(false)
  // Tracks being imported, and those imported here (shown as in the library before the search refreshes).
  const [importing, setImporting] = useState<ReadonlySet<string>>(new Set())
  const [imported, setImported] = useState<Record<string, string>>({})
  const audio = useRef<HTMLAudioElement | null>(null)
  const results = useQuery({
    queryKey: ['openverse-search', query, license, category],
    enabled: props.opened && query.length > 0,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<SearchResult> => {
      setSlow(false)
      const r = await fetchClient.GET('/api/v1/media/openverse/search', {
        params: { query: { q: query, license, category } },
        signal,
      })
      if (r.error) throw new Error(errorMessage(r.error))
      if ('items' in r.data) return r.data
      setSlow(true)
      const job = await finished(r.data, signal)
      if (!job.search) throw new Error(TOO_SLOW)
      return job.search
    },
  })
  // Audio already in the library that matches: no Openverse call, so it shows at once.
  const library = useQuery({
    queryKey: ['openverse-library', query],
    enabled: props.opened && query.length > 0,
    retry: false,
    queryFn: async ({ signal }): Promise<Media[]> => {
      const r = await fetchClient.GET('/api/v1/media/openverse/library', {
        params: { query: { q: query } },
        signal,
      })
      if (r.error) throw new Error(errorMessage(r.error))
      return r.data.items
    },
  })
  const common = useQuery({
    queryKey: ['openverse-common'],
    enabled: props.opened,
    staleTime: Infinity,
    queryFn: async (): Promise<string[]> => {
      const r = await fetchClient.GET('/api/v1/media/openverse/common')
      return r.data?.queries ?? []
    },
  })
  const run = (q: string) => {
    stop()
    setDraft(q)
    setQuery(q)
  }

  const importIt = async (t: Track) => {
    setImporting((s) => new Set(s).add(t.id))
    try {
      const r = await fetchClient.POST('/api/v1/media/openverse/import', { body: { id: t.id } })
      if (r.error) throw new Error(errorMessage(r.error))
      // 202: importing in the background.
      const m = 'search' in r.data ? (await finished(r.data)).media : r.data
      if (!m) throw new Error(TOO_SLOW)
      setImported((x) => ({ ...x, [t.id]: m.id }))
      void qc.invalidateQueries({ queryKey: ['get', '/api/v1/media'] })
      void qc.invalidateQueries({ queryKey: ['openverse-library'] })
      notifications.show({ message: `${m.source?.title ?? m.filename} is in the library.` })
      props.onImported?.(m)
    } catch (e) {
      notifications.show({ color: 'red', message: errorMessage(e) })
    } finally {
      setImporting((s) => {
        const next = new Set(s)
        next.delete(t.id)
        return next
      })
    }
  }

  const stop = () => {
    audio.current?.pause()
    setPlaying(null)
  }
  // Closing the dialog stops any preview.
  useEffect(() => {
    if (!props.opened) stop()
  }, [props.opened])
  /** Plays (or stops) one preview: an Openverse track by its id, a library item by its media id. */
  const toggle = (key: string, url: string | null | undefined) => {
    const el = audio.current
    if (!el || !url) return
    if (playing === key) return stop()
    el.src = url
    setClock({ at: 0, length: 0 })
    setPlaying(key)
    el.play().catch((e: unknown) => {
      // Switching tracks interrupts the last play(); only a real failure of this one says so.
      if (e instanceof DOMException && e.name === 'AbortError') return
      setPlaying((p) => (p === key ? null : p))
      notifications.show({ color: 'red', message: "This preview couldn't play." })
    })
  }
  const playButton = (key: string, url: string | null | undefined, title: string) => (
    <ActionIcon
      variant={playing === key ? 'filled' : 'default'}
      radius="xl"
      size="lg"
      disabled={!url}
      aria-label={`${playing === key ? 'Stop' : 'Play'} ${title}`}
      aria-pressed={playing === key}
      onClick={() => {
        toggle(key, url)
      }}
      data-testid={`preview-${key}`}
    >
      {playing === key ? <IconPlayerStopFilled size={14} /> : <IconPlayerPlayFilled size={14} />}
    </ActionIcon>
  )

  /** The playing preview's timeline: click or drag to jump; arrow keys step 5 s. */
  const timeline = (title: string, knownLength: number | null | undefined) => {
    const length = clock.length || knownLength || 0
    return (
      <Group gap="xs" wrap="nowrap" mt={6} data-testid="preview-timeline">
        <Text size="xs" c="var(--va-faint)" className="num" w={34}>
          {duration(Math.min(clock.at, length))}
        </Text>
        <Slider
          flex={1}
          size="sm"
          min={0}
          max={Math.max(length, 0.1)}
          step={0.1}
          value={Math.min(clock.at, length)}
          disabled={!length}
          label={(v) => duration(v)}
          thumbLabel={`Position in ${title}`}
          onChange={(v) => {
            setClock((c) => ({ ...c, at: v }))
            if (audio.current) audio.current.currentTime = v
          }}
          onKeyDown={(e) => {
            const el = audio.current
            if (!el || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
            e.preventDefault()
            el.currentTime = Math.max(0, Math.min(length, el.currentTime + (e.key === 'ArrowRight' ? 5 : -5)))
          }}
        />
        <Text size="xs" c="var(--va-faint)" className="num" w={34} ta="right">
          {length ? duration(length) : '–:––'}
        </Text>
      </Group>
    )
  }

  const items = results.data?.items ?? []
  const owned = library.data ?? []
  return (
    <Modal opened={props.opened} onClose={props.onClose} title="Find music on Openverse" size="lg">
      <Stack gap="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            run(draft.trim())
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
        {common.data?.length ? (
          <Group gap={6} role="group" aria-label="Quick searches" data-testid="quick-searches">
            {common.data.map((q) => (
              <Button
                key={q}
                size="compact-xs"
                radius="xl"
                variant={query === q ? 'filled' : 'default'}
                aria-pressed={query === q}
                onClick={() => {
                  run(q)
                }}
              >
                {q}
              </Button>
            ))}
          </Group>
        ) : null}
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
          onLoadedMetadata={(e) => {
            const length = e.currentTarget.duration
            setClock((c) => ({ ...c, length: Number.isFinite(length) ? length : 0 }))
          }}
          onTimeUpdate={(e) => {
            const at = e.currentTarget.currentTime
            setClock((c) => (Math.abs(c.at - at) >= 0.2 ? { ...c, at } : c))
          }}
          hidden
        />
        {owned.length ? (
          <Stack gap={6} data-testid="library-matches">
            <Text size="xs" fw={600} c="var(--va-muted)">
              In your library
            </Text>
            {owned.map((m) => {
              const title = m.source?.title ?? m.caption ?? m.filename
              return (
                <Group
                  key={m.id}
                  wrap="nowrap"
                  gap="sm"
                  className="va-openverse-row"
                  data-testid={`library-${m.id}`}
                >
                  {playButton(m.id, m.urls?.file, title)}
                  <Stack gap={0} flex={1} miw={0}>
                    <Text size="sm" fw={600} truncate title={title}>
                      {title}
                    </Text>
                    <Text size="xs" c="var(--va-muted)" truncate>
                      {[m.source?.creator, m.durationSec ? duration(m.durationSec) : null, m.filename]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                    {playing === m.id ? timeline(title, m.durationSec) : null}
                  </Stack>
                  {m.source?.licenseLabel ? (
                    <Badge size="sm" variant="light" color={m.source.license === 'cc0' ? 'teal' : 'blue'}>
                      {m.source.licenseLabel}
                    </Badge>
                  ) : null}
                  {props.onImported ? (
                    <Button
                      size="compact-sm"
                      variant="default"
                      onClick={() => {
                        props.onImported?.(m)
                      }}
                    >
                      Use
                    </Button>
                  ) : (
                    <Badge size="sm" variant="outline" color="gray">
                      In library
                    </Badge>
                  )}
                </Group>
              )
            })}
            <Text size="xs" fw={600} c="var(--va-muted)" mt={4}>
              On Openverse
            </Text>
          </Stack>
        ) : null}
        {results.data?.fetchedAt &&
        (results.data.stale || Date.now() - Date.parse(results.data.fetchedAt) > HOUR) ? (
          <Text size="xs" c="var(--va-faint)" data-testid="openverse-updated">
            Updated {relativeTime(results.data.fetchedAt)}
            {results.data.stale ? ' · refreshing in the background' : ''}
          </Text>
        ) : null}
        {results.error ? (
          <Group gap="sm" wrap="nowrap">
            <Text size="sm" c="red" data-testid="openverse-error">
              {errorMessage(results.error)}
            </Text>
            <Button
              size="compact-sm"
              variant="default"
              onClick={() => {
                void results.refetch()
              }}
            >
              Retry
            </Button>
          </Group>
        ) : results.isFetching && !results.data ? (
          <Group gap="xs" wrap="nowrap" data-testid="openverse-searching" role="status">
            <Loader size="xs" />
            <Text size="sm" c="var(--va-muted)">
              Searching Openverse…
              {slow ? ' It’s slow right now; this can take up to a minute.' : ''}
            </Text>
          </Group>
        ) : query && items.length === 0 ? (
          <Text size="sm" c="var(--va-muted)">
            No tracks found. Try other words.
          </Text>
        ) : (
          <Stack gap={6} className="va-openverse-list">
            {items
              .map((t) => ({ ...t, mediaId: t.mediaId ?? imported[t.id] ?? null }))
              .map((t) => (
                <Group
                  key={t.id}
                  wrap="nowrap"
                  gap="sm"
                  className="va-openverse-row"
                  data-testid={`track-${t.id}`}
                >
                  {playButton(t.id, t.previewUrl, t.title)}
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
                    {playing === t.id ? timeline(t.title, t.durationSec) : null}
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
                      disabled={!t.importable || importing.has(t.id)}
                      leftSection={importing.has(t.id) ? <Loader size={12} /> : undefined}
                      title={
                        t.importable
                          ? undefined
                          : "This track's file doesn't fit the library (type, size or length)."
                      }
                      onClick={() => {
                        void importIt(t)
                      }}
                    >
                      {importing.has(t.id) ? 'Importing…' : 'Import'}
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
        <MoreMusicSources />
      </Stack>
    </Modal>
  )
}

/** Other sites with music to download, each opening in a new tab; the file then goes in with Upload. */
export function MoreMusicSources() {
  return (
    <details className="va-music-sources" data-testid="music-sources">
      <summary>
        <Text component="span" size="sm" fw={500}>
          More places to find music
        </Text>
      </summary>
      <Text size="xs" c="var(--va-muted)" mt={6} mb={8}>
        Download a track there, then add it with Upload on the Media page. Check each track’s licence: avoid
        NC (non-commercial) and ND (no-derivatives), and put any required credit in the caption.
      </Text>
      <Stack gap={8}>
        {MUSIC_SOURCES.map((s) => (
          <div key={s.url}>
            <Group gap={6} wrap="nowrap">
              <Anchor href={s.url} target="_blank" rel="noopener noreferrer" size="sm" fw={500}>
                {s.name}
              </Anchor>
              <IconExternalLink size={12} color="var(--va-faint)" />
              <Badge size="xs" variant="light" color="gray">
                {s.licence}
              </Badge>
            </Group>
            <Text size="xs" c="var(--va-faint)">
              {s.note}
            </Text>
          </div>
        ))}
      </Stack>
    </details>
  )
}
