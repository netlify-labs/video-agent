import {
  Alert,
  Button,
  Center,
  Group,
  Select,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { useDebouncedValue, useHotkeys } from '@mantine/hooks'
import { IconLock, IconSearch } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { $api, errorMessage, type Video } from '../api/client'
import { StageTrack, Status, duration, fileUrl, inProgress, relativeTime } from '../components/bits'
import { QuickCreate } from './NewVideo'

function elapsed(iso: string | null | undefined): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

function VideoCard({ v }: { v: Video }) {
  const ready = v.versions.find((x) => x.status === 'ready')
  const latest = v.versions[0]
  const [hover, setHover] = useState(false)
  const working = latest && inProgress(latest.status)
  const live = v.versions.some((x) => x.publications.some((p) => !p.unpublishedAt))
  return (
    <Link
      to={`/videos/${v.id}`}
      className="va-card"
      onMouseEnter={() => {
        setHover(true)
      }}
      onMouseLeave={() => {
        setHover(false)
      }}
    >
      <div className="va-poster">
        {ready && !working ? (
          <img src={fileUrl(v.id, ready.n, hover ? 'gif' : 'poster')} alt="" loading="lazy" />
        ) : working ? (
          <Stack gap={10} w="70%">
            <Group justify="space-between">
              <Text size="sm" fw={500}>
                {latest.status === 'queued'
                  ? 'Waiting for a slot'
                  : latest.status === 'finishing'
                    ? 'Saving the files'
                    : `Making v${latest.n}`}
              </Text>
              <Text size="sm" c="var(--va-muted)" className="num">
                {elapsed(latest.timings?.queuedAt)}
              </Text>
            </Group>
            <StageTrack version={latest} />
          </Stack>
        ) : (
          <Text size="sm" c="var(--va-faint)">
            {latest?.error?.category === 'needs_input' ? 'Needs a clearer prompt' : 'No video'}
          </Text>
        )}
      </div>
      <div className="va-card-body">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <div className="va-card-title">
            {v.private ? (
              <IconLock size={13} aria-label="Private" style={{ marginRight: 4, verticalAlign: -1 }} />
            ) : null}
            {v.title}
          </div>
          {latest ? <Status status={latest.status} size="xs" /> : null}
        </Group>
        <div className="va-prompt">{latest?.prompt}</div>
        <div className="va-meta num">
          {[
            v.owner.name ?? v.owner.email?.split('@')[0],
            relativeTime(v.createdAt),
            v.aspect,
            ready?.output ? duration(ready.output.durationSec) : null,
            v.versions.length > 1 ? `${v.versions.length} versions` : null,
            live ? 'Public' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
    </Link>
  )
}

function CardSkeleton() {
  return (
    <div className="va-card">
      <div className="va-poster" />
      <div className="va-card-body">
        <Skeleton height={14} width="60%" />
        <Skeleton height={14} mt={10} />
        <Skeleton height={14} mt={6} width="80%" />
        <Skeleton height={12} mt={12} width="50%" />
      </div>
    </div>
  )
}

export function LibraryPage() {
  const [q, setQ] = useState('')
  const [debounced] = useDebouncedValue(q, 300)
  const [owner, setOwner] = useState<'all' | 'me'>('all')
  const [status, setStatus] = useState<string | null>(null)
  const [published, setPublished] = useState<string | null>(null)
  const search = useRef<HTMLInputElement>(null)
  useHotkeys([['/', () => search.current?.focus()]])

  const query = {
    owner,
    ...(debounced ? { q: debounced } : {}),
    ...(status ? { status: status as Video['status'] } : {}),
    ...(published ? { published: published as 'true' | 'false' } : {}),
  }
  const list = $api.useInfiniteQuery(
    'get',
    '/api/v1/videos',
    { params: { query: { ...query, limit: 24 } } },
    {
      pageParamName: 'cursor',
      initialPageParam: '',
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      refetchInterval: (q) =>
        q.state.data?.pages.some((p) => p.items.some((v) => inProgress(v.status))) ? 10_000 : false,
    },
  )
  const items = list.data?.pages.flatMap((p) => p.items) ?? []
  const filtered = Boolean(debounced || status || published || owner === 'me')
  const working = items.filter((v) => inProgress(v.status)).length
  const finding =
    items.length === 0
      ? filtered
        ? 'No videos match these filters.'
        : 'Nothing yet. Describe a video and the agent makes it in a few minutes.'
      : `${items.length}${list.hasNextPage ? '+' : ''} ${items.length === 1 ? 'video' : 'videos'}${working ? `, ${working} in progress` : ''}${filtered ? ' in this view' : ''}.`

  return (
    <Stack gap={0}>
      <div className="va-title-row">
        <div>
          <Title order={1}>Library</Title>
          <div className="va-sub">{list.isLoading ? 'Loading…' : finding}</div>
        </div>
        <Group gap="sm">
          <TextInput
            ref={search}
            aria-label="Search prompts and titles"
            placeholder="Search prompts and titles"
            leftSection={<IconSearch size={16} />}
            value={q}
            onChange={(e) => {
              setQ(e.currentTarget.value)
            }}
            radius="xl"
            w={280}
            visibleFrom="sm"
          />
          <Button component={Link} to="/new">
            New video
          </Button>
        </Group>
      </div>
      <Group gap="sm" mb="lg" wrap="wrap">
        <SegmentedControl
          value={owner}
          onChange={(v) => {
            setOwner(v)
          }}
          data={[
            { label: 'Everyone', value: 'all' },
            { label: 'Mine', value: 'me' },
          ]}
        />
        <Select
          aria-label="Status"
          placeholder="Any status"
          clearable
          value={status}
          onChange={setStatus}
          w={160}
          radius="xl"
          data={[
            { value: 'ready', label: 'Ready' },
            { value: 'running', label: 'Making' },
            { value: 'queued', label: 'Queued' },
            { value: 'failed', label: 'Failed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'timed_out', label: 'Timed out' },
          ]}
        />
        <Select
          aria-label="Public or not"
          placeholder="Public or not"
          clearable
          value={published}
          onChange={setPublished}
          w={160}
          radius="xl"
          data={[
            { value: 'true', label: 'Public' },
            { value: 'false', label: 'Not public' },
          ]}
        />
        <TextInput
          aria-label="Search prompts and titles"
          placeholder="Search"
          leftSection={<IconSearch size={16} />}
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value)
          }}
          radius="xl"
          style={{ flex: 1 }}
          hiddenFrom="sm"
        />
      </Group>
      {list.isError ? (
        <Alert color="red" variant="light" title="Couldn't load videos">
          <Group justify="space-between">
            <Text size="sm">{errorMessage(list.error)}</Text>
            <Button variant="default" size="xs" onClick={() => void list.refetch()}>
              Retry
            </Button>
          </Group>
        </Alert>
      ) : list.isLoading ? (
        <div className="va-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : items.length === 0 && !filtered ? (
        <QuickCreate />
      ) : items.length === 0 ? (
        <div className="va-empty">No videos match. Clear a filter or search for other words.</div>
      ) : (
        <div className="va-grid">
          {items.map((v) => (
            <VideoCard key={v.id} v={v} />
          ))}
        </div>
      )}
      {list.hasNextPage ? (
        <Center mt="xl">
          <Button
            variant="default"
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Show more
          </Button>
        </Center>
      ) : null}
    </Stack>
  )
}
