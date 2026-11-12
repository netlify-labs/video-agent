import {
  Alert,
  Button,
  Combobox,
  Group,
  Loader,
  Menu,
  Pill,
  PillsInput,
  Select,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
  useCombobox,
} from '@mantine/core'
import { useDebouncedValue, useHotkeys, useReducedMotion } from '@mantine/hooks'
import {
  IconArrowsShuffle,
  IconDots,
  IconEyeOff,
  IconLock,
  IconMessage,
  IconSearch,
  IconTag,
} from '@tabler/icons-react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useTagsInUse } from '../components/TagsField'
import { $api, commentsInit, errorMessage, useCanCreate, videoInit, type Video } from '../api/client'
import {
  PageHeader,
  Status,
  VersionImage,
  clockTime,
  duration,
  inProgress,
  localUrl,
  relativeTime,
} from '../components/bits'
import { FavoriteStar } from '../components/FavoriteButton'
import { LoadMore } from '../components/LoadMore'
import { RemixDialog, latestReady, useCanRemix } from '../components/RemixDialog'
import { lazyPage, newVideoRoute, videoRoute } from '../routes'
import { useLibraryTools } from '../webmcp/libraryTools'

// Shown only in an empty library, so the form's code loads only then.
const QuickCreate = lazyPage(newVideoRoute, (m) => m.QuickCreate)

function elapsed(iso: string | null | undefined): string {
  if (!iso) return ''
  return clockTime(Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000))
}

/** How wide a tile is at each breakpoint of .va-grid, so the browser picks the 480 or 960 px poster. */
const TILE_SIZES =
  '(max-width: 520px) 100vw, (max-width: 820px) 50vw, (max-width: 1100px) 33vw, (max-width: 1680px) 25vw, 20vw'

/** Tiles in the first row at the widest breakpoints; their posters are the page's largest paint. */
const FIRST_ROW = 4

type Clip = NonNullable<NonNullable<Video['versions'][number]['files']>['clip']>

/** The muted hover clip over the poster. Mounted on the first hover only, so nothing is fetched before. */
function HoverClip({ sources, playing }: { sources: Clip; playing: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.muted = true
    if (playing) void el.play().catch(() => undefined)
    else el.pause()
  }, [playing])
  return (
    <video
      ref={ref}
      className="va-clip"
      data-playing={playing ? 'true' : undefined}
      muted
      loop
      playsInline
      preload="auto"
      disablePictureInPicture
      aria-hidden
      tabIndex={-1}
    >
      {sources.map((s) => (
        <source key={s.type} src={localUrl(s.src)} type={s.type} />
      ))}
    </video>
  )
}

/** Warms a video's page when a tile is hovered or focused: its code, the video and its comments, as the very queries
 * the page makes (fresh ones aren't fetched again). */
function usePrefetchVideo(id: string) {
  const qc = useQueryClient()
  return () => {
    void videoRoute.load().catch(() => undefined)
    void qc.query($api.queryOptions('get', '/api/v1/videos/{id}', videoInit(id))).catch(() => undefined)
    void qc
      .query($api.queryOptions('get', '/api/v1/videos/{id}/comments', commentsInit(id)))
      .catch(() => undefined)
  }
}

function VideoCard({ v, priority }: { v: Video; priority: boolean }) {
  const ready = v.versions.find((x) => x.status === 'ready')
  const latest = v.versions[0]
  const [hover, setHover] = useState(false)
  // The clip replaces the GIF for versions that have one; it isn't created before the first hover.
  const [armed, setArmed] = useState(false)
  const reduceMotion = useReducedMotion()
  const clip = reduceMotion ? undefined : ready?.files?.clip
  const working = latest && inProgress(latest.status)
  const live = v.versions.some((x) => x.publications.some((p) => !p.unpublishedAt))
  const approved = v.versions.reduce((n, x) => n + x.verdicts.approved, 0)
  const prefetch = usePrefetchVideo(v.id)
  return (
    // Hover is the whole tile's, so moving onto the star doesn't stop the clip.
    <div
      className="va-tile"
      onMouseEnter={() => {
        setHover(true)
        setArmed(true)
        prefetch()
      }}
      onMouseLeave={() => {
        setHover(false)
      }}
    >
      <Link to={`/videos/${v.id}`} className="va-card" onFocus={prefetch} onTouchStart={prefetch}>
        <div className="va-poster">
          {ready && !working ? (
            clip ? (
              <>
                <VersionImage videoId={v.id} v={ready} file="poster" sizes={TILE_SIZES} priority={priority} />
                {armed ? <HoverClip sources={clip} playing={hover} /> : null}
              </>
            ) : (
              <VersionImage
                videoId={v.id}
                v={ready}
                file={hover ? 'gif' : 'poster'}
                sizes={TILE_SIZES}
                priority={priority}
              />
            )
          ) : working ? (
            // A loading state, so a video being made never looks like a finished one: a spinner, what's happening,
            // and how long it's been going, over a slow sweep of light.
            <Stack gap={10} align="center" className="va-card-working" data-testid="card-working">
              <Loader size={30} color="var(--va-accent)" aria-hidden />
              <Text size="sm" fw={500} role="status">
                {latest.status === 'queued'
                  ? 'Waiting for a slot'
                  : latest.status === 'finishing'
                    ? 'Saving the files'
                    : `Making v${latest.n}`}
              </Text>
              <Text size="sm" c="var(--va-muted)" className="num" aria-label="Elapsed">
                {elapsed(latest.timings?.queuedAt)}
              </Text>
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
            <Group gap={6} wrap="nowrap">
              {v.comments.count > 0 ? (
                <span
                  className="va-comment-count num"
                  data-unread={v.comments.unread > 0 ? 'true' : undefined}
                  aria-label={
                    v.comments.unread > 0
                      ? `${v.comments.unread} unread comments`
                      : `${v.comments.count} comments`
                  }
                >
                  <IconMessage size={13} />
                  {v.comments.unread > 0 ? v.comments.unread : v.comments.count}
                </span>
              ) : null}
              {latest ? <Status status={latest.status} size="xs" /> : null}
            </Group>
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
              v.isRemix ? 'Remix' : null,
              ...v.tags.map((t) => `#${t}`),
              approved ? `${approved} approved` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </Link>
      <FavoriteStar videoId={v.id} favorite={v.favorite} />
      <TileMenu v={v} />
    </div>
  )
}

/** A tile's "⋯" menu beside the star (outside the tile's link, like the star). Remix uses the latest ready version. */
function TileMenu({ v }: { v: Video }) {
  const canRemix = useCanRemix()
  const [remixing, setRemixing] = useState(false)
  if (!canRemix) return null
  const ready = latestReady(v)
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <UnstyledButton className="va-tile-menu" aria-label={`More for ${v.title}`}>
            <IconDots size={16} />
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          <Tooltip label="Remix needs a ready version" disabled={ready !== undefined} position="left">
            <div>
              <Menu.Item
                leftSection={<IconArrowsShuffle size={14} />}
                disabled={!ready}
                onClick={() => {
                  setRemixing(true)
                }}
              >
                Remix
              </Menu.Item>
            </div>
          </Tooltip>
        </Menu.Dropdown>
      </Menu>
      {remixing && ready ? (
        <RemixDialog
          video={v}
          version={ready}
          opened
          onClose={() => {
            setRemixing(false)
          }}
        />
      ) : null}
    </>
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

const HIDE_TAGS_KEY = 'va.library.hideTags'
/** Where one hidden tag was remembered before the filter took several. */
const OLD_HIDE_TAG_KEY = 'va.library.hideTag'
/** Hidden until someone says otherwise: demo videos, so the library opens on the real ones. */
const DEFAULT_HIDDEN_TAGS = ['demo']

/** The tags hidden on this device; the default until this device has chosen (an emptied list is a choice). */
function savedHiddenTags(): string[] {
  try {
    const raw = localStorage.getItem(HIDE_TAGS_KEY) ?? localStorage.getItem(OLD_HIDE_TAG_KEY)
    return raw === null ? DEFAULT_HIDDEN_TAGS : raw.split(',').filter(Boolean)
  } catch {
    return DEFAULT_HIDDEN_TAGS
  }
}

/**
 * The tag filter: one searchable field. Its list offers every tag in use twice, to show only videos with it or to
 * hide videos with it; what's picked sits in the field as pills (hidden ones marked with a crossed eye), each with
 * an × to remove it.
 */
function TagFilter(props: {
  show: string[]
  hide: string[]
  onShow: (tags: string[]) => void
  onHide: (tags: string[]) => void
  inUse: { tag: string; count: number }[]
}) {
  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption()
    },
  })
  const [search, setSearch] = useState('')
  const picked = new Set([...props.show, ...props.hide])
  const matches = props.inUse.filter(
    (t) => !picked.has(t.tag) && t.tag.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const pick = (value: string) => {
    if (value.startsWith('hide:')) props.onHide([...props.hide, value.slice(5)])
    else props.onShow([...props.show, value])
    setSearch('')
  }
  const pill = (tag: string, hidden: boolean) => (
    <Pill
      key={`${hidden ? 'hide' : 'show'}:${tag}`}
      withRemoveButton
      data-hidden={hidden || undefined}
      style={{ flexShrink: 0 }}
      title={hidden ? `Videos tagged ${tag} are hidden` : `Only videos tagged ${tag}`}
      onRemove={() => {
        if (hidden) props.onHide(props.hide.filter((t) => t !== tag))
        else props.onShow(props.show.filter((t) => t !== tag))
      }}
    >
      {hidden ? (
        <IconEyeOff size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-label="Hidden:" />
      ) : null}
      {tag}
    </Pill>
  )
  const option = (value: string, t: { tag: string; count: number }) => (
    <Combobox.Option key={value} value={value}>
      <Group justify="space-between" gap="md" wrap="nowrap">
        <span>{t.tag}</span>
        <Text span size="xs" c="var(--va-faint)">
          {t.count}
        </Text>
      </Group>
    </Combobox.Option>
  )
  return (
    <Combobox store={combobox} onOptionSubmit={pick} withinPortal>
      <Combobox.DropdownTarget>
        <PillsInput
          radius="xl"
          // One line, always: the field widens with each pill instead of wrapping onto a second line (the filter row
          // wraps as a whole when it runs out of room).
          miw={180}
          leftSection={<IconTag size={15} />}
          data-testid="tag-filter"
          onClick={() => {
            combobox.openDropdown()
          }}
        >
          <Pill.Group style={{ flexWrap: 'nowrap' }}>
            {props.hide.map((t) => pill(t, true))}
            {props.show.map((t) => pill(t, false))}
            <Combobox.EventsTarget>
              <PillsInput.Field
                aria-label="Tags"
                // Room to type a tag's first letters; the pills take the rest.
                style={{ minWidth: 72, flex: '1 0 72px' }}
                placeholder={picked.size ? undefined : 'Tags'}
                value={search}
                onFocus={() => {
                  combobox.openDropdown()
                }}
                onBlur={() => {
                  combobox.closeDropdown()
                }}
                onChange={(e) => {
                  setSearch(e.currentTarget.value)
                  combobox.openDropdown()
                  combobox.selectFirstOption()
                }}
                onKeyDown={(e) => {
                  // Type part of a tag and press Enter to show only it. A pasted or fast-typed tag can reach Enter
                  // before the list has an option highlighted: take the first match then.
                  const first = matches[0]
                  if (e.key === 'Enter' && search && first && combobox.getSelectedOptionIndex() < 0) {
                    e.preventDefault()
                    pick(first.tag)
                    return
                  }
                  if (e.key !== 'Backspace' || search) return
                  // In the empty field, Backspace removes the last pill.
                  if (props.show.length) props.onShow(props.show.slice(0, -1))
                  else if (props.hide.length) props.onHide(props.hide.slice(0, -1))
                }}
              />
            </Combobox.EventsTarget>
          </Pill.Group>
        </PillsInput>
      </Combobox.DropdownTarget>
      <Combobox.Dropdown>
        <Combobox.Options mah={320} style={{ overflowY: 'auto' }}>
          {matches.length ? (
            <>
              <Combobox.Group label="Show only">{matches.map((t) => option(t.tag, t))}</Combobox.Group>
              <Combobox.Group label="Hide">{matches.map((t) => option(`hide:${t.tag}`, t))}</Combobox.Group>
            </>
          ) : (
            <Combobox.Empty>No other tags</Combobox.Empty>
          )}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  )
}

export function LibraryPage() {
  const [q, setQ] = useState('')
  const [debounced] = useDebouncedValue(q, 300)
  // Favorites is a view of its own: your starred videos, by anyone.
  const [owner, setOwner] = useState<'all' | 'me' | 'favorites'>('all')
  const [status, setStatus] = useState<string | null>(null)
  const canCreate = useCanCreate()
  const [published, setPublished] = useState<string | null>(null)
  // One tag filter with two kinds of pick: videos with any of some tags, and hiding videos with any of others.
  // Hiding is remembered on this device and starts with demo, so demo videos stay out of the way until asked for.
  const tagsInUse = useTagsInUse()
  const [tags, setTags] = useState<string[]>([])
  const [hideTags, setHideTagsState] = useState<string[]>(savedHiddenTags)
  const setHideTags = (t: string[]) => {
    setHideTagsState(t)
    try {
      // Saved even when empty: removing the default is a choice to remember.
      localStorage.setItem(HIDE_TAGS_KEY, t.join(','))
      localStorage.removeItem(OLD_HIDE_TAG_KEY)
    } catch {
      // Not remembered, then.
    }
  }
  // Asking for a tag shows it even if it's a hidden one.
  const hidden = hideTags.filter((t) => !tags.includes(t))
  const search = useRef<HTMLInputElement>(null)
  useHotkeys([['/', () => search.current?.focus()]])
  // WebMCP (va-qago): an agent searches and filters through the same controls.
  useLibraryTools({ setQuery: setQ, setOwner, setStatus, setPublished })

  const query = {
    owner: owner === 'me' ? ('me' as const) : ('all' as const),
    ...(owner === 'favorites' ? { favorite: 'true' as const } : {}),
    ...(debounced ? { q: debounced } : {}),
    ...(status ? { status: status as Video['status'] } : {}),
    ...(published ? { published: published as 'true' | 'false' } : {}),
    ...(tags.length ? { tag: tags.join(',') } : {}),
    ...(hidden.length ? { withoutTag: hidden.join(',') } : {}),
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
  // Hiding demo videos is how the library opens, not a filter someone set.
  const hidingMore = hideTags.join(',') !== DEFAULT_HIDDEN_TAGS.join(',') && hideTags.length > 0
  const filtered = Boolean(debounced || status || published || tags.length || hidingMore || owner !== 'all')
  const working = items.filter((v) => inProgress(v.status)).length
  const finding =
    items.length === 0
      ? filtered
        ? 'No videos match these filters.'
        : 'Nothing yet. Describe a video and the agent makes it in a few minutes.'
      : `${items.length}${list.hasNextPage ? '+' : ''} ${items.length === 1 ? 'video' : 'videos'}${working ? `, ${working} in progress` : ''}${filtered ? ' in this view' : ''}.`

  return (
    <Stack gap={0}>
      <PageHeader title="Library" sub={list.isLoading ? 'Loading…' : finding}>
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
          {canCreate ? (
            <Button component={Link} to="/new">
              New video
            </Button>
          ) : null}
        </Group>
      </PageHeader>
      <Group gap="sm" mb="lg" wrap="wrap">
        <SegmentedControl
          value={owner}
          onChange={(v) => {
            setOwner(v)
          }}
          data={[
            { label: 'Everyone', value: 'all' },
            { label: 'Mine', value: 'me' },
            { label: 'Favorites', value: 'favorites' },
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
        {tagsInUse.length || tags.length || hideTags.length ? (
          <TagFilter show={tags} hide={hideTags} onShow={setTags} onHide={setHideTags} inUse={tagsInUse} />
        ) : null}
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
        canCreate ? (
          <Suspense fallback={null}>
            <QuickCreate />
          </Suspense>
        ) : (
          <div className="va-empty">No videos yet. Creators' videos will show up here.</div>
        )
      ) : items.length === 0 && owner === 'favorites' && !debounced && !status && !published ? (
        <div className="va-empty">No favorites yet. Star a video to keep it here.</div>
      ) : items.length === 0 ? (
        <div className="va-empty">No videos match. Clear a filter or search for other words.</div>
      ) : (
        <div className="va-grid">
          {items.map((v, i) => (
            <VideoCard key={v.id} v={v} priority={i < FIRST_ROW} />
          ))}
        </div>
      )}
      {/* Scrolling near the end loads the next 24. */}
      <LoadMore
        hasMore={list.hasNextPage}
        loading={list.isFetchingNextPage}
        failed={list.isFetchNextPageError}
        onMore={() => void list.fetchNextPage()}
      />
    </Stack>
  )
}
