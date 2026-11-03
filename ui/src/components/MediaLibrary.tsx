// The media library's shared browsing parts, for the Media page and the Add media picker: search (title, file
// name, notes), sort, a Table/Grid switch (table by default, remembered per browser), the table itself, and a
// dialog to rename an item and edit its notes.
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { modals } from '@mantine/modals'
import {
  IconFileTypePdf,
  IconLayoutGrid,
  IconList,
  IconMovie,
  IconMusic,
  IconPencil,
  IconSearch,
  IconTypography,
} from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'
import { fetchClient } from '../api/client'
import type { paths } from '../api/schema'
import { duration, relativeTime, showError } from './bits'

type Media = paths['/api/v1/media/{id}']['get']['responses'][200]['content']['application/json']
export type MediaSort = 'newest' | 'oldest' | 'name'
export type MediaView = 'table' | 'grid'

/** What people see an item called: the title they gave it, else its file name. */
export const mediaName = (m: Pick<Media, 'title' | 'filename'>) => m.title ?? m.filename

const VIEW_KEY = 'va-media-view'
function readView(): MediaView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'table'
  } catch {
    return 'table'
  }
}

/** Search, sort and view for a library list; the search is debounced for the server query. */
export function useLibraryControls() {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<MediaSort>('newest')
  const [view, setViewState] = useState<MediaView>(readView)
  const [q] = useDebouncedValue(search.trim(), 250)
  const setView = (v: MediaView) => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  }
  /** The list query's params: only what's set, so the default request stays as it was. */
  const query = { ...(q ? { q } : {}), ...(sort !== 'newest' ? { sort } : {}) }
  return { search, setSearch, sort, setSort, view, setView, query, searching: q !== '' }
}

export function LibraryToolbar(props: ReturnType<typeof useLibraryControls> & { children?: ReactNode }) {
  return (
    <Group gap="sm" wrap="wrap" className="va-library-toolbar">
      <TextInput
        className="va-library-search"
        leftSection={<IconSearch size={16} />}
        placeholder="Search by name or notes"
        aria-label="Search media"
        value={props.search}
        onChange={(e) => {
          props.setSearch(e.currentTarget.value)
        }}
      />
      <Select
        aria-label="Sort"
        w={150}
        allowDeselect={false}
        value={props.sort}
        onChange={(v) => {
          if (v) props.setSort(v)
        }}
        data={[
          { value: 'newest', label: 'Newest first' },
          { value: 'oldest', label: 'Oldest first' },
          { value: 'name', label: 'Name (A–Z)' },
        ]}
      />
      {props.children}
      <SegmentedControl
        aria-label="View"
        value={props.view}
        onChange={(v) => {
          props.setView(v)
        }}
        data={[
          {
            value: 'table',
            label: (
              <>
                <IconList size={14} className="va-view-icon" />
                Table
              </>
            ),
          },
          {
            value: 'grid',
            label: (
              <>
                <IconLayoutGrid size={14} className="va-view-icon" />
                Grid
              </>
            ),
          },
        ]}
      />
    </Group>
  )
}

const KIND_WORD: Record<Media['kind'], string> = {
  image: 'Image',
  svg: 'SVG',
  video: 'Clip',
  audio: 'Audio',
  font: 'Font',
  pdf: 'PDF',
}
const size = (n: number) =>
  n < 1048576
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`

/** A clip or track's length, an image's size in pixels, else the file size. */
const lengthOrSize = (m: Media) =>
  m.durationSec ? duration(m.durationSec) : m.width && m.height ? `${m.width}×${m.height}` : size(m.bytes)

/** A row's small preview: the image or poster when there is one, else an icon for the kind. */
function RowThumb({ m }: { m: Media }) {
  const src = m.urls
    ? m.kind === 'video'
      ? m.urls.poster
      : m.kind === 'image' || m.kind === 'svg'
        ? m.urls.file
        : null
    : null
  return (
    <span className="va-row-thumb" aria-hidden>
      {src ? (
        <img src={src} alt="" loading="lazy" />
      ) : m.kind === 'audio' ? (
        <IconMusic size={16} />
      ) : m.kind === 'pdf' ? (
        <IconFileTypePdf size={16} />
      ) : m.kind === 'font' ? (
        <IconTypography size={16} />
      ) : (
        <IconMovie size={16} />
      )}
    </span>
  )
}

/**
 * The library as a table. With `select`, a row toggles when clicked (checkbox first); `actions` adds a last column.
 */
export function MediaTable(props: {
  items: Media[]
  select?: { isOn: (m: Media) => boolean; toggle: (m: Media) => void; canPick: (m: Media) => boolean }
  actions?: (m: Media) => ReactNode
  testIdPrefix: string
}) {
  const { select } = props
  return (
    <div className="va-table-wrap">
      <Table className="va-media-table" verticalSpacing={6} highlightOnHover stickyHeader>
        <Table.Thead>
          <Table.Tr>
            {select ? <Table.Th w={36} aria-label="Selected" /> : null}
            <Table.Th className="va-col-name">Name</Table.Th>
            <Table.Th visibleFrom="sm">Type</Table.Th>
            <Table.Th visibleFrom="sm">Length / size</Table.Th>
            <Table.Th>Uploaded</Table.Th>
            <Table.Th visibleFrom="md">Used in</Table.Th>
            {props.actions ? <Table.Th w={44} aria-label="Actions" /> : null}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {props.items.map((m) => {
            const on = select?.isOn(m) ?? false
            const pickable = select?.canPick(m) ?? false
            return (
              <Table.Tr
                key={m.id}
                data-testid={`${props.testIdPrefix}${m.id}`}
                data-on={on || undefined}
                data-disabled={select && !pickable ? true : undefined}
                aria-selected={select ? on : undefined}
                onClick={select && pickable ? () => select.toggle(m) : undefined}
                className={select ? 'va-row-pick' : undefined}
              >
                {select ? (
                  <Table.Td>
                    <Checkbox
                      aria-label={`Select ${mediaName(m)}`}
                      checked={on}
                      disabled={!pickable}
                      onChange={() => {
                        select.toggle(m)
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                      }}
                    />
                  </Table.Td>
                ) : null}
                <Table.Td className="va-col-name">
                  <Group gap="sm" wrap="nowrap" miw={0}>
                    <RowThumb m={m} />
                    <Stack gap={0} miw={0}>
                      <Text size="sm" fw={500} truncate title={mediaName(m)}>
                        {mediaName(m)}
                      </Text>
                      {m.title || m.caption ? (
                        <Text size="xs" c="var(--va-faint)" truncate title={m.caption ?? m.filename}>
                          {[m.title ? m.filename : null, m.caption].filter(Boolean).join(' · ')}
                        </Text>
                      ) : null}
                      {/* On phones the Type and Length columns are hidden: the same facts, under the name. */}
                      <Text size="xs" c="var(--va-faint)" hiddenFrom="sm" className="num">
                        {KIND_WORD[m.kind]} · {lengthOrSize(m)}
                      </Text>
                      {m.source ? <SourceLine source={m.source} /> : null}
                      {m.kind === 'audio' && m.urls ? (
                        // Plays from the signed URL; nothing loads until someone presses play.
                        <audio
                          className="va-row-audio"
                          controls
                          preload="none"
                          src={m.urls.file}
                          aria-label={`Play ${mediaName(m)}`}
                          data-testid={`player-${m.id}`}
                          onClick={(e) => {
                            e.stopPropagation()
                          }}
                        />
                      ) : null}
                      {m.status !== 'ready' ? (
                        <Text size="xs" c={m.status === 'rejected' ? 'red' : 'var(--va-faint)'}>
                          {m.status === 'rejected' ? (m.rejectReason ?? 'Rejected') : 'Checking…'}
                        </Text>
                      ) : null}
                    </Stack>
                  </Group>
                </Table.Td>
                <Table.Td visibleFrom="sm">
                  <Text size="sm" c="var(--va-muted)">
                    {KIND_WORD[m.kind]}
                  </Text>
                </Table.Td>
                <Table.Td visibleFrom="sm">
                  <Text size="sm" c="var(--va-muted)" className="num">
                    {lengthOrSize(m)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="var(--va-muted)" title={new Date(m.createdAt).toLocaleString()}>
                    {relativeTime(m.createdAt)}
                  </Text>
                  <Text size="xs" c="var(--va-faint)" truncate>
                    {m.uploader.name ?? m.uploader.email?.split('@')[0]}
                  </Text>
                </Table.Td>
                <Table.Td visibleFrom="md">
                  <Text size="sm" c="var(--va-muted)" className="num">
                    {m.usedIn ? `${m.usedIn} video${m.usedIn === 1 ? '' : 's'}` : '—'}
                  </Text>
                </Table.Td>
                {props.actions ? (
                  <Table.Td
                    onClick={(e) => {
                      e.stopPropagation()
                    }}
                  >
                    {props.actions(m)}
                  </Table.Td>
                ) : null}
              </Table.Tr>
            )
          })}
        </Table.Tbody>
      </Table>
    </div>
  )
}

function DetailsForm({ m, onDone }: { m: Media; onDone: (saved: boolean) => void }) {
  const [title, setTitle] = useState(m.title ?? '')
  const [notes, setNotes] = useState(m.caption ?? '')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    const { error } = await fetchClient.PATCH('/api/v1/media/{id}', {
      params: { path: { id: m.id } },
      body: { title: title.trim() || null, caption: notes.trim() || null },
    })
    setSaving(false)
    if (error) showError(error)
    else onDone(true)
  }
  return (
    <Stack gap="md">
      <TextInput
        label="Name"
        description={`Shown in the library instead of the file name (${m.filename}). Leave empty to use the file name.`}
        maxLength={120}
        value={title}
        placeholder={m.filename}
        onChange={(e) => {
          setTitle(e.currentTarget.value)
        }}
        data-autofocus
      />
      <Textarea
        label="Notes"
        description="What it is and how to use it. Search finds these words, and the planner and the agent read them."
        autosize
        minRows={3}
        maxRows={8}
        maxLength={500}
        value={notes}
        onChange={(e) => {
          setNotes(e.currentTarget.value)
        }}
      />
      <Group justify="flex-end" gap="sm">
        <Button
          variant="default"
          onClick={() => {
            onDone(false)
          }}
        >
          Cancel
        </Button>
        <Button loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </Group>
    </Stack>
  )
}

/** Opens the rename-and-notes dialog; `onSaved` runs after a successful save. */
export function editMediaDetails(m: Media, onSaved: () => void) {
  const id = modals.open({
    title: `Edit ${mediaName(m)}`,
    size: 'lg',
    children: (
      <DetailsForm
        m={m}
        onDone={(saved) => {
          modals.close(id)
          if (saved) onSaved()
        }}
      />
    ),
  })
}

/** A row's edit button: opens the rename-and-notes dialog. */
export function EditDetailsButton({ m, onSaved }: { m: Media; onSaved: () => void }) {
  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      size="sm"
      aria-label={`Edit ${mediaName(m)}`}
      onClick={() => {
        editMediaDetails(m, onSaved)
      }}
    >
      <IconPencil size={14} />
    </ActionIcon>
  )
}

/** An imported item's licence, creator and a link to the work. */
export function SourceLine({ source }: { source: NonNullable<Media['source']> }) {
  return (
    <Group gap={6} wrap="nowrap" data-testid="media-source">
      <Badge
        size="xs"
        variant="light"
        color={source.creditRequired ? 'blue' : 'teal'}
        title={source.creditRequired ? 'Videos that use it credit it automatically' : 'No credit needed'}
      >
        {source.licenseLabel}
      </Badge>
      <Text size="xs" c="var(--va-muted)" truncate>
        {source.creator ? (
          source.creatorUrl ? (
            <Anchor href={source.creatorUrl} target="_blank" rel="noopener" c="inherit" size="xs">
              {source.creator}
            </Anchor>
          ) : (
            source.creator
          )
        ) : null}
        {source.creator ? ' · ' : ''}
        {source.url ? (
          <Anchor href={source.url} target="_blank" rel="noopener" c="inherit" size="xs">
            Openverse
          </Anchor>
        ) : (
          'Openverse'
        )}
      </Text>
    </Group>
  )
}
