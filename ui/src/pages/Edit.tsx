// The browser editor (plan v2 §8): change text, beat timing, colours, beat order, media slots and music on a
// finished contract-1 version, see it in the sandboxed preview, and render it unchanged as the next version. The page holds the composition the
// person wants; the op list sent on each save is its difference from the version, so saves are idempotent.
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Card,
  ColorSwatch,
  Group,
  Menu,
  NumberInput,
  SegmentedControl,
  Slider,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import {
  IconArrowDown,
  IconArrowUp,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconTrash,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { $api, errorMessage, fetchClient, newIdempotencyKey } from '../api/client'
import type { paths } from '../api/schema'
import { confirmDanger, showError } from '../components/bits'
import { CompositionPreview, type PreviewCommand } from '../components/CompositionPreview'
import { MediaLibraryModal, type Media } from '../components/MediaPicker'
import { humanize, labelFor } from '../lib/labels'

type Edit = paths['/api/v1/edits/{id}']['get']['responses'][200]['content']['application/json']
type Composition = Edit['composition']
type Op = Edit['ops'][number]
type Slot = Composition['beats'][number]['media'][number]
type Track = Composition['audio'][number]

const fps = (s: number) => Math.round(s * 30) / 30
const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-6

/**
 * The ops that turn `base` into `cur`, in the order the patcher needs: deletes, order, timing, text, colour, media,
 * audio.
 */
export function diffOps(base: Composition, cur: Composition): Op[] {
  const ops: Op[] = []
  const curIds = cur.beats.map((b) => b.id)
  for (const b of base.beats) if (!curIds.includes(b.id)) ops.push({ op: 'delete', beat: b.id })
  const kept = base.beats.map((b) => b.id).filter((id) => curIds.includes(id))
  if (kept.join() !== curIds.join()) ops.push({ op: 'reorder', order: curIds })
  for (const b of cur.beats) {
    const was = base.beats.find((x) => x.id === b.id)
    if (was && !sameNumber(was.duration, b.duration))
      ops.push({ op: 'retime', beat: b.id, duration: b.duration })
  }
  const baseTexts = new Map(base.beats.flatMap((b) => b.texts.map((t) => [t.id, t.text] as const)))
  for (const t of cur.beats.flatMap((b) => b.texts))
    if (baseTexts.get(t.id) !== t.text) ops.push({ op: 'text', id: t.id, text: t.text })
  for (const [role, value] of Object.entries(cur.colors))
    if (base.colors[role]?.toLowerCase() !== value.toLowerCase()) ops.push({ op: 'color', role, value })
  const baseSlots = new Map(base.beats.flatMap((b) => b.media.map((m) => [m.slot, m] as const)))
  for (const m of cur.beats.flatMap((b) => b.media)) {
    const was = baseSlots.get(m.slot)
    const fit = m.fit === 'cover' ? 'cover' : 'contain'
    if (was && (was.src !== m.src || (was.fit ?? 'contain') !== fit))
      ops.push({ op: 'media', slot: m.slot, src: m.src, kind: m.kind, fit })
  }
  const baseAudio = new Map(base.audio.map((a) => [a.id, a] as const))
  for (const a of cur.audio) {
    const was = baseAudio.get(a.id)
    if (!was) continue
    const change = {
      ...(was.src !== a.src ? { src: a.src } : {}),
      ...(!sameNumber(was.volume, a.volume) ? { volume: a.volume } : {}),
      ...(was.muted !== a.muted ? { muted: a.muted } : {}),
    }
    if (Object.keys(change).length) ops.push({ op: 'audio', id: a.id, ...change })
  }
  return ops
}

/** Library files sit in assets/media/ as <media id>.<ext>. */
const libraryId = (src: string) => /^assets\/media\/(med_[A-Za-z0-9]+)\.[A-Za-z0-9]+$/.exec(src)?.[1] ?? null

/** One audio track: its file's name, Replace, a level and Mute. */
function AudioRow({
  track,
  item,
  onChange,
  onReplace,
}: {
  track: Track
  /** The library item picked in this session, if any. */
  item: Media | undefined
  onChange: (patch: Partial<Track>) => void
  onReplace: () => void
}) {
  const id = libraryId(track.src)
  // The library's name for the file (not just its id); a deleted or hidden item falls back to the file name.
  const lib = $api.useQuery(
    'get',
    '/api/v1/media/{id}',
    { params: { path: { id: id ?? '' } } },
    { enabled: !!id && !item, retry: false, staleTime: Infinity },
  )
  const name = labelFor(track.label, track.id)
  const file = item?.filename ?? lib.data?.filename ?? track.src.split('/').pop() ?? track.src
  return (
    <div className="va-slot" data-testid={`audio-${track.id}`}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <IconMusic size={18} />
          <div style={{ minWidth: 0 }}>
            <Text size="xs" fw={500}>
              {name}
            </Text>
            <Text size="xs" c="var(--va-faint)" truncate title={file}>
              {file}
            </Text>
          </div>
        </Group>
        <Group gap={4} wrap="nowrap">
          <Tooltip label={track.muted ? 'Unmute' : 'Mute'}>
            <ActionIcon
              variant={track.muted ? 'light' : 'subtle'}
              color={track.muted ? 'red' : 'gray'}
              aria-label={`Mute ${name}`}
              aria-pressed={track.muted}
              onClick={() => {
                onChange({ muted: !track.muted })
              }}
            >
              {track.muted ? <IconVolumeOff size={14} /> : <IconVolume size={14} />}
            </ActionIcon>
          </Tooltip>
          <Button size="compact-xs" variant="default" aria-label={`Replace ${name}`} onClick={onReplace}>
            Replace
          </Button>
        </Group>
      </Group>
      <Group gap="xs" wrap="nowrap" mt={8}>
        <Text size="xs" c="var(--va-faint)" w={52}>
          Volume
        </Text>
        <Slider
          style={{ flex: 1 }}
          size="sm"
          min={0}
          max={Math.max(2, track.volume)}
          step={0.05}
          value={track.volume}
          disabled={track.muted}
          label={(v) => `${Math.round(v * 100)}%`}
          thumbLabel={`Volume of ${name}`}
          onChange={(v) => {
            onChange({ volume: Math.round(v * 100) / 100 })
          }}
        />
        <Text size="xs" c="var(--va-faint)" className="num" w={36} ta="right">
          {track.muted ? 'Off' : `${Math.round(track.volume * 100)}%`}
        </Text>
      </Group>
    </div>
  )
}

export function EditPage() {
  const { id = '', n = '' } = useParams()
  const versionN = Number(n)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const video = $api.useQuery('get', '/api/v1/videos/{id}', { params: { path: { id } } })
  const [draft, setDraft] = useState<Edit | null>(null)
  const [cur, setCur] = useState<Composition | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [renderKey] = useState(newIdempotencyKey)
  const sendRef = useRef<((c: PreviewCommand) => void) | null>(null)
  const fields = useRef<Record<string, HTMLInputElement | null>>({})
  // The slot being replaced, and the library items picked so far (for their thumbnails).
  const [replacing, setReplacing] = useState<Slot | null>(null)
  const [replacingAudio, setReplacingAudio] = useState<Track | null>(null)
  const [picked, setPicked] = useState<Record<string, Media>>({})

  useEffect(() => {
    void (async () => {
      const { data, error } = await fetchClient.POST('/api/v1/videos/{id}/versions/{n}/edits', {
        params: { path: { id, n: versionN } },
      })
      if (data) {
        setDraft(data)
        setCur(data.composition)
      } else setProblem(errorMessage(error))
    })()
  }, [id, versionN])

  const ops = useMemo(() => (draft && cur ? diffOps(draft.base, cur) : []), [draft, cur])
  const dirty = !!draft && JSON.stringify(ops) !== JSON.stringify(draft.ops)

  const save = useCallback(async () => {
    if (!draft) return
    setSaving(true)
    const { data, error, response } = await fetchClient.PUT('/api/v1/edits/{id}', {
      params: { path: { id: draft.id } },
      body: { rev: draft.rev, ops },
    })
    setSaving(false)
    if (data) {
      setDraft(data)
      setProblem(null)
    } else if (response.status === 409) setProblem(errorMessage(error))
    else {
      // The edit can't be made: show why and go back to the last saved state.
      showError(error)
      setCur(draft.composition)
    }
  }, [draft, ops])

  // Save shortly after the last change.
  useEffect(() => {
    if (!dirty || saving) return
    const t = setTimeout(() => void save(), 700)
    return () => {
      clearTimeout(t)
    }
  }, [dirty, saving, save])

  const update = (fn: (c: Composition) => Composition) => {
    setCur((c) => (c ? fn(structuredClone(c)) : c))
  }
  const setText = (textId: string, text: string) => {
    update((c) => {
      for (const b of c.beats) for (const t of b.texts) if (t.id === textId) t.text = text
      return c
    })
    // Text shows up in the preview right away; everything else after the save.
    sendRef.current?.({ type: 'apply-edits', edits: [{ id: textId, text }] })
  }
  const setSlot = (slot: string, patch: Partial<Slot>) => {
    update((c) => {
      for (const b of c.beats) for (const m of b.media) if (m.slot === slot) Object.assign(m, patch)
      return c
    })
  }
  const setTrack = (trackId: string, patch: Partial<Track>) => {
    update((c) => {
      for (const a of c.audio) if (a.id === trackId) Object.assign(a, patch)
      return c
    })
  }
  const move = (i: number, by: number) => {
    update((c) => {
      const [b] = c.beats.splice(i, 1)
      if (b) c.beats.splice(i + by, 0, b)
      return c
    })
  }

  const onPreviewClick = useCallback((c: { textId: string | null }) => {
    const el = c.textId ? fields.current[c.textId] : null
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.focus()
      el.select()
    }
  }, [])
  const onReady = useCallback((send: (c: PreviewCommand) => void) => {
    sendRef.current = send
  }, [])

  const render = $api.useMutation('post', '/api/v1/edits/{id}/render', {
    onSuccess: (v) => {
      void qc.invalidateQueries()
      notifications.show({ color: 'teal', message: `Rendering v${v.latestVersion} with your edits.` })
      void navigate(`/videos/${id}`)
    },
    onError: showError,
  })
  const discard = $api.useMutation('delete', '/api/v1/edits/{id}', {
    onSuccess: () => void navigate(`/videos/${id}`),
  })

  if (problem && !draft)
    return (
      <Alert color="red" variant="light" title="Can't edit this version">
        <Text size="sm">{problem}</Text>
        <Anchor component={Link} to={`/videos/${id}`} size="sm">
          Back to the video
        </Anchor>
      </Alert>
    )
  if (!draft || !cur || !video.data) return <Text c="var(--va-muted)">Opening the editor…</Text>
  const total = cur.beats.reduce((s, b) => s + b.duration, 0)
  // Music for now; voice lines and effects get their own rows later.
  const music = cur.audio.filter((a) => a.role === 'music')
  const next = video.data.versions.length + 1

  // The preview stays put on the left with the actions above it; the controls scroll on their own on the right.
  const aspect = video.data.dimensions.width / video.data.dimensions.height
  return (
    <div className="va-editor">
      <div className="va-editor-stage" style={{ ['--va-aspect' as string]: aspect }}>
        <Anchor component={Link} to={`/videos/${id}`} size="sm" c="var(--va-muted)">
          {video.data.title}
        </Anchor>
        <div className="va-title-row" style={{ marginTop: 4, marginBottom: 0 }}>
          <div>
            <Title order={1}>Edit v{draft.baseN}</Title>
            <div className="va-sub num" data-testid="edit-status">
              {Math.round(total * 10) / 10} s · {cur.beats.length} beats ·{' '}
              {saving ? 'Saving…' : dirty ? 'Unsaved changes' : draft.rev ? 'Draft saved' : 'No changes yet'}
            </div>
          </div>
          <Group gap="sm">
            <Button
              variant="subtle"
              color="gray"
              onClick={() => {
                confirmDanger({
                  title: 'Discard this draft?',
                  body: "Your edits are deleted. The video doesn't change.",
                  confirm: 'Discard',
                  cancel: 'Keep editing',
                  onConfirm: () => {
                    discard.mutate({ params: { path: { id: draft.id } } })
                  },
                })
              }}
            >
              Discard
            </Button>
            <Button
              disabled={!draft.rev || dirty || saving}
              loading={render.isPending}
              onClick={() => {
                render.mutate({
                  params: { path: { id: draft.id }, header: { 'idempotency-key': renderKey } },
                })
              }}
            >
              Render as v{next}
            </Button>
          </Group>
        </div>

        {draft.newerVersion ? (
          <Alert color="yellow" variant="light" mb="md">
            v{draft.newerVersion} now exists.{' '}
            <Anchor component={Link} to={`/videos/${id}/edit/${draft.newerVersion}`}>
              Start from v{draft.newerVersion}
            </Anchor>
            , or render yours as v{next}.
          </Alert>
        ) : null}
        {problem ? (
          <Alert color="red" variant="light" mb="md">
            {problem}{' '}
            <Anchor
              onClick={() => {
                window.location.reload()
              }}
            >
              Reload
            </Anchor>
          </Alert>
        ) : null}

        <CompositionPreview
          videoId={id}
          versionN={draft.baseN}
          dimensions={video.data.dimensions}
          draft={{ editId: draft.id, rev: draft.rev }}
          onClick={onPreviewClick}
          onReady={onReady}
        />
        <Text size="xs" c="var(--va-faint)">
          Click any text in the preview to edit it. Text changes show at once; timing, order, colours, media
          and audio after the draft saves.
        </Text>
      </div>
      <div className="va-editor-panel" data-testid="edit-panel">
        <Card>
          <Text fw={600} mb="sm">
            Beats
          </Text>
          <Stack gap="sm">
            {cur.beats.map((b, i) => (
              <div key={b.id} className="va-beat" data-testid={`beat-${b.id}`} title={b.id}>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm" fw={600}>
                    {i + 1}. {labelFor(b.label, b.id)}
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    <NumberInput
                      aria-label={`Length of ${labelFor(b.label, b.id)}`}
                      size="xs"
                      w={92}
                      min={0.5}
                      max={120}
                      step={0.1}
                      decimalScale={2}
                      suffix=" s"
                      value={Math.round(b.duration * 100) / 100}
                      onChange={(v) => {
                        const d = Number(v)
                        if (d >= 0.5 && d <= 120)
                          update((c) => {
                            const x = c.beats.find((y) => y.id === b.id)
                            if (x) x.duration = fps(d)
                            return c
                          })
                      }}
                    />
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={`Move ${labelFor(b.label, b.id)} earlier`}
                      disabled={i === 0}
                      onClick={() => {
                        move(i, -1)
                      }}
                    >
                      <IconArrowUp size={14} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={`Move ${labelFor(b.label, b.id)} later`}
                      disabled={i === cur.beats.length - 1}
                      onClick={() => {
                        move(i, 1)
                      }}
                    >
                      <IconArrowDown size={14} />
                    </ActionIcon>
                    <Tooltip label="The last beat can't be deleted" disabled={cur.beats.length > 1}>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Delete ${labelFor(b.label, b.id)}`}
                        disabled={cur.beats.length <= 1}
                        onClick={() => {
                          update((c) => ({ ...c, beats: c.beats.filter((x) => x.id !== b.id) }))
                        }}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
                <Stack gap={6} mt={6}>
                  {b.texts.map((t) => (
                    <TextInput
                      key={t.id}
                      size="xs"
                      label={labelFor(t.label, t.id, b.id)}
                      maxLength={500}
                      value={t.text}
                      ref={(el) => {
                        fields.current[t.id] = el
                      }}
                      data-text-id={t.id}
                      onChange={(e) => {
                        setText(t.id, e.currentTarget.value)
                      }}
                    />
                  ))}
                  {b.media.map((m) => {
                    const file = m.src.split('/').pop() ?? m.src
                    const item = picked[file]
                    const name = labelFor(m.label, m.slot, b.id)
                    return (
                      <div key={m.slot} className="va-slot" data-testid={`slot-${m.slot}`}>
                        <Group justify="space-between" wrap="nowrap" gap="xs">
                          <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                            {item?.urls && (item.kind !== 'video' || item.urls.poster) ? (
                              <img
                                className="va-slot-thumb"
                                src={item.kind === 'video' ? (item.urls.poster ?? '') : item.urls.file}
                                alt=""
                              />
                            ) : m.kind === 'video' ? (
                              <IconMovie size={18} />
                            ) : (
                              <IconPhoto size={18} />
                            )}
                            <div style={{ minWidth: 0 }}>
                              <Text size="xs" fw={500}>
                                {name}
                              </Text>
                              <Text size="xs" c="var(--va-faint)" truncate>
                                {item?.filename ?? file}
                              </Text>
                            </div>
                          </Group>
                          <Group gap={4} wrap="nowrap">
                            <SegmentedControl
                              size="xs"
                              aria-label={`Fit for ${name}`}
                              value={m.fit === 'cover' ? 'cover' : 'contain'}
                              onChange={(v) => {
                                setSlot(m.slot, { fit: v })
                              }}
                              data={[
                                { value: 'contain', label: 'Fit' },
                                { value: 'cover', label: 'Fill' },
                              ]}
                            />
                            <Button
                              size="compact-xs"
                              variant="default"
                              aria-label={`Replace ${name}`}
                              onClick={() => {
                                setReplacing(m)
                              }}
                            >
                              Replace
                            </Button>
                          </Group>
                        </Group>
                      </div>
                    )
                  })}
                </Stack>
              </div>
            ))}
          </Stack>
        </Card>
        {music.length ? (
          <Card data-testid="audio-card">
            <Text fw={600} mb="sm">
              Audio
            </Text>
            <Stack gap="sm">
              {music.map((a) => (
                <AudioRow
                  key={a.id}
                  track={a}
                  item={picked[a.src.split('/').pop() ?? '']}
                  onChange={(patch) => {
                    setTrack(a.id, patch)
                  }}
                  onReplace={() => {
                    setReplacingAudio(a)
                  }}
                />
              ))}
            </Stack>
          </Card>
        ) : null}
        <Card>
          <Text fw={600} mb="sm">
            Colours
          </Text>
          <Stack gap={8}>
            {Object.entries(cur.colors).map(([role, value]) => (
              <Group key={role} justify="space-between">
                <Text size="sm" title={role}>
                  {humanize(role)}
                </Text>
                <Menu position="bottom-end">
                  <Menu.Target>
                    <Button
                      size="xs"
                      variant="default"
                      aria-label={`Colour for ${humanize(role)}`}
                      leftSection={<ColorSwatch color={value} size={14} />}
                    >
                      {value}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>Brand palette</Menu.Label>
                    {draft.palette.map((c) => (
                      <Menu.Item
                        key={c}
                        leftSection={<ColorSwatch color={c} size={14} />}
                        onClick={() => {
                          update((x) => ({ ...x, colors: { ...x.colors, [role]: c } }))
                        }}
                      >
                        {c}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              </Group>
            ))}
          </Stack>
        </Card>
      </div>
      {replacing ? (
        <MediaLibraryModal
          opened
          title={`Replace ${labelFor(replacing.label, replacing.slot, replacing.beat ?? undefined)}`}
          kinds={replacing.kind === 'video' ? ['video'] : ['image', 'svg']}
          onClose={() => {
            setReplacing(null)
          }}
          onPick={([m]) => {
            if (!m) return
            // Library files sit in assets/media/ as <id>.<ext>; the filename keeps the extension.
            const file = `${m.id}.${m.filename.split('.').pop() ?? ''}`
            setPicked((p) => ({ ...p, [file]: m }))
            setSlot(replacing.slot, { src: `assets/media/${file}` })
          }}
        />
      ) : null}
      {replacingAudio ? (
        <MediaLibraryModal
          opened
          title={`Replace ${labelFor(replacingAudio.label, replacingAudio.id)}`}
          kinds={['audio']}
          onClose={() => {
            setReplacingAudio(null)
          }}
          onPick={([m]) => {
            if (!m) return
            const file = `${m.id}.${m.filename.split('.').pop() ?? ''}`
            setPicked((p) => ({ ...p, [file]: m }))
            setTrack(replacingAudio.id, { src: `assets/media/${file}` })
          }}
        />
      ) : null}
    </div>
  )
}
