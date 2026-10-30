import { AspectRatio, Button, Card, Center, Group, Image, Loader, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core'
import { useDebouncedValue, useHotkeys } from '@mantine/hooks'
import { IconPhoto, IconSearch, IconWorld } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { $api, type Video } from '../api/client'
import { StatusBadge, duration, fileUrl, inProgress, relativeTime } from '../components/bits'
import { QuickCreate } from './NewVideo'

function VideoCard({ v }: { v: Video }) {
  const ready = v.versions.find((x) => x.status === 'ready')
  const latest = v.versions[0]
  const [hover, setHover] = useState(false)
  return (
    <Card component={Link} to={`/videos/${v.id}`} withBorder padding="sm" radius="md" onMouseEnter={() => { setHover(true) }} onMouseLeave={() => { setHover(false) }}>
      <Card.Section>
        <AspectRatio ratio={16 / 9} bg="dark.8">
          {ready ? (
            <Image src={fileUrl(v.id, ready.n, hover ? 'gif' : 'poster')} alt="" fit="contain" loading="lazy" />
          ) : (
            <Center>{inProgress(v.status) ? <Loader size="sm" /> : <IconPhoto opacity={0.4} />}</Center>
          )}
        </AspectRatio>
      </Card.Section>
      <Stack gap={4} mt="sm">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text fw={600} lineClamp={1}>
            {v.title}
          </Text>
          <Group gap={4} wrap="nowrap">
            {v.published ? <IconWorld size={14} aria-label="Published" /> : null}
            <StatusBadge status={v.status} />
          </Group>
        </Group>
        <Text size="sm" c="dimmed" lineClamp={2}>
          {latest?.prompt}
        </Text>
        <Text size="xs" c="dimmed">
          {[v.owner.name ?? v.owner.email, relativeTime(v.createdAt), v.aspect, duration(ready?.output?.durationSec), v.versions.length > 1 ? `v${v.latestVersion}` : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Stack>
    </Card>
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
      initialPageParam: undefined as unknown as string,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      refetchInterval: (q) => (q.state.data?.pages.some((p) => p.items.some((v) => inProgress(v.status))) ? 15_000 : false),
    },
  )
  const items = list.data?.pages.flatMap((p) => p.items) ?? []
  const filtered = Boolean(debounced || status || published || owner === 'me')

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Library</Title>
        <Button component={Link} to="/new">
          New video
        </Button>
      </Group>
      <Group gap="sm" wrap="wrap">
        <TextInput ref={search} placeholder="Search prompts and titles  ( / )" leftSection={<IconSearch size={16} />} value={q} onChange={(e) => { setQ(e.currentTarget.value) }} style={{ flex: 1, minWidth: 220 }} />
        <SegmentedControl value={owner} onChange={(v) => { setOwner(v) }} data={[{ label: 'Everyone', value: 'all' }, { label: 'Mine', value: 'me' }]} />
        <Select placeholder="Any status" clearable value={status} onChange={setStatus} w={150} data={[{ value: 'ready', label: 'Ready' }, { value: 'running', label: 'Making' }, { value: 'queued', label: 'Queued' }, { value: 'failed', label: 'Failed' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'timed_out', label: 'Timed out' }]} />
        <Select placeholder="Published or not" clearable value={published} onChange={setPublished} w={170} data={[{ value: 'true', label: 'Published' }, { value: 'false', label: 'Not published' }]} />
      </Group>
      {list.isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : items.length === 0 && !filtered ? (
        <QuickCreate />
      ) : items.length === 0 ? (
        <Text c="dimmed">No videos match.</Text>
      ) : (
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3, xl: 4 }}>
          {items.map((v) => (
            <VideoCard key={v.id} v={v} />
          ))}
        </SimpleGrid>
      )}
      {list.hasNextPage ? (
        <Center>
          <Button variant="default" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            Load more
          </Button>
        </Center>
      ) : null}
    </Stack>
  )
}
