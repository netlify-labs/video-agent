// The browser editor (plan v2 §8): change text, beat timing, colours, beat order, media slots, music and narration
// lines on a finished contract-1 version, see it in the sandboxed preview, and render it unchanged as the next version. The page holds the composition the
// person wants; the op list sent on each save is its difference from the version, so saves are idempotent. With recorded
// voice-over on, a Narration section (plan 2026-11-02 §2.3-§2.5) adds the narration op to that list, and Render asks how.
// Opening it takes the narration lock (§2.7), and while timing changes are pending it offers Render picture first.
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
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
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import {
  IconArrowBackUp,
  IconArrowDown,
  IconArrowUp,
  IconMicrophone,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconTrash,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { $api, errorMessage, fetchClient, newIdempotencyKey, useNarrationEnabled } from '../api/client'
import type { paths } from '../api/schema'
import { confirmDanger, showError } from '../components/bits'
import { CompositionPreview, type PreviewCommand } from '../components/CompositionPreview'
import { MediaLibraryModal, type Media } from '../components/MediaPicker'
import { NarrationRenderDialog, type RenderChoice } from '../components/NarrationRenderDialog'
import { NarrationSection, type NarrationControl } from '../components/NarrationSection'
import {
  keepMineWarning,
  NarrationLockBanner,
  NarrationStaleBanner,
  useNarrationLock,
} from '../components/narration'
import { RenderPictureFirst } from '../components/RenderPictureFirst'
import { humanize, labelFor } from '../lib/labels'
import { narrationOf, narrationToSave, sameOps, videoSamples, withNarration } from '../lib/narration-panel'
import { timingChanged } from '../../../src/lib/stale-picture'
import type { NarrationOp } from '../../../src/lib/timeline'

type Edit = paths['/api/v1/edits/{id}']['get']['responses'][200]['content']['application/json']
type Composition = Edit['composition']
type Op = Edit['ops'][number]
type Slot = Composition['beats'][number]['media'][number]
type Track = Composition['audio'][number]
type Line = Composition['narration'][number]

const fps = (s: number) => Math.round(s * 30) / 30
const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-6
/** Narration as it is spoken: one line, single spaces (the patcher compares lines the same way). */
const spoken = (text: string) => text.replace(/\s+/g, ' ').trim()
/** Whether a line differs from the version's, so the render re-voices it. */
const relined = (base: Composition, line: Line) => {
  const was = base.narration.find((x) => x.beat === line.beat)
  return !!was && spoken(was.text) !== spoken(line.text)
}

/**
 * The ops that turn `base` into `cur`, in the order the patcher needs: deletes, order, timing, text, colour, media,
 * audio, narration.
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
  for (const l of cur.narration)
    if (curIds.includes(l.beat) && spoken(l.text) && relined(base, l))
      ops.push({ op: 'voice', beat: l.beat, text: l.text })
  return ops
}

/** Under a changed field: what the version had, and a button to put it back. */
function Was({ value, name, onRevert }: { value: string; name: string; onRevert: () => void }) {
  return (
    <Group gap={6} wrap="nowrap" data-testid="was">
      <Text size="xs" c="var(--va-faint)" truncate title={value} style={{ flex: 1, minWidth: 0 }}>
        Was: {value || '(empty)'}
      </Text>
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        leftSection={<IconArrowBackUp size={12} />}
        aria-label={`Revert ${name}`}
        onClick={onRevert}
      >
        Revert
      </Button>
    </Group>
  )
}

const percent = (v: number) => `${Math.round(v * 100)}%`
const fileOf = (src: string) => src.split('/').pop() ?? src

/** Library files sit in assets/media/ as <media id>.<ext>. */
const libraryId = (src: string) => /^assets\/media\/(med_[A-Za-z0-9]+)\.[A-Za-z0-9]+$/.exec(src)?.[1] ?? null

/** One audio track: its file's name, Replace, a level and Mute. */
function AudioRow({
  track,
  was,
  item,
  onChange,
  onReplace,
}: {
  track: Track
  /** The track in the version, to show and revert to when this one differs. */
  was: Track | undefined
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
  const file = item?.filename ?? lib.data?.filename ?? fileOf(track.src)
  const before = was
    ? [
        was.src !== track.src ? fileOf(was.src) : null,
        was.muted !== track.muted || !sameNumber(was.volume, track.volume)
          ? was.muted
            ? 'muted'
            : `volume ${percent(was.volume)}`
          : null,
      ].filter((x) => x !== null)
    : []
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
          {track.muted ? 'Off' : percent(track.volume)}
        </Text>
      </Group>
      {was && before.length ? (
        <Was
          value={before.join(', ')}
          name={name}
          onRevert={() => {
            onChange({ src: was.src, volume: was.volume, muted: was.muted })
          }}
        />
      ) : null}
    </div>
  )
}

/** One voiced beat's narration line; a changed line is re-voiced when the draft renders. */
function VoiceRow({
  line,
  name,
  was,
  onChange,
}: {
  line: Line
  name: string
  /** The line as the version speaks it, when this one differs (and is re-voiced on render). */
  was: string | null
  onChange: (text: string) => void
}) {
  return (
    <div className="va-slot" data-testid={`voice-${line.beat}`}>
      <Group justify="space-between" wrap="nowrap" gap="xs" mb={6}>
        <Group gap={8} wrap="nowrap">
          <IconMicrophone size={16} />
          <Text size="xs" fw={500}>
            {name}
          </Text>
        </Group>
        {was !== null ? (
          <Badge size="xs" variant="light" color="teal">
            Re-voice on render
          </Badge>
        ) : null}
      </Group>
      <Textarea
        size="xs"
        aria-label={`Narration for ${name}`}
        autosize
        minRows={1}
        maxRows={5}
        maxLength={600}
        value={line.text}
        error={spoken(line.text) ? undefined : 'A line needs some words'}
        onChange={(e) => {
          onChange(e.currentTarget.value)
        }}
      />
      {was !== null ? (
        <Was
          value={was}
          name={`narration for ${name}`}
          onRevert={() => {
            onChange(was)
          }}
        />
      ) : null}
    </div>
  )
}

/** One editor per version: Render picture first reopens on the next one with nothing carried over. */
export function EditPage() {
  const { id = '', n = '' } = useParams()
  return <EditVersion key={`${id}/${n}`} id={id} versionN={Number(n)} />
}

function EditVersion({ id, versionN }: { id: string; versionN: number }) {
  const navigate = useNavigate()
  // Reopened by Render picture first: the narration was moved here on purpose, so there's nothing to ask about.
  const reopened = (useLocation().state as { narrationReady?: boolean } | null)?.narrationReady === true
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
  // Edits left from an earlier visit (or a refresh): asked once whether to keep them or start over.
  const [resumed, setResumed] = useState(0)
  // Recorded narration: the op the Narration section shows, and what it starts from (a new key remounts it).
  const narrationOn = useNarrationEnabled()
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  const [narration, setNarration] = useState<NarrationOp | null>(null)
  const [narrationStart, setNarrationStart] = useState<{ op: NarrationOp | null; key: number }>({
    op: null,
    key: 0,
  })
  const resetNarration = (op: NarrationOp | null) => {
    setNarration(op)
    setNarrationStart((s) => ({ op, key: s.key + 1 }))
  }
  const narrationControl = useRef<NarrationControl | null>(null)
  const [renderDialog, setRenderDialog] = useState(false)

  useEffect(() => {
    void (async () => {
      const { data, error } = await fetchClient.POST('/api/v1/videos/{id}/versions/{n}/edits', {
        params: { path: { id, n: versionN } },
      })
      if (data) {
        setDraft(data)
        setCur(data.composition)
        setResumed(reopened ? 0 : data.ops.length)
        const op = narrationOf(data.ops)
        setNarration(op)
        setNarrationStart((s) => ({ op, key: s.key + 1 }))
      } else setProblem(errorMessage(error))
    })()
  }, [id, versionN, reopened])

  // The narration lock (plan 2026-11-02 §2.7): held while the Narration section is open; without it the track is
  // read-only and Record is off. A newer version with other narration offers Rebase or Keep mine.
  const lock = useNarrationLock(narrationOn && draft ? id : null, draft?.id ?? null)
  const [takingOver, setTakingOver] = useState(false)
  const [keptMine, setKeptMine] = useState(false)
  const [rebasing, setRebasing] = useState(false)
  // Render picture first queued v`n`: the draft is rendered, so it stops saving until the editor reopens there.
  const [pictureN, setPictureN] = useState<number | null>(null)

  // The narration op goes last, as one snapshot of the whole track (none while it's empty, or when narration is off).
  const ops = useMemo(
    () =>
      draft && cur
        ? (withNarration(diffOps(draft.base, cur), narrationOn ? narrationToSave(narration) : null) as Op[])
        : [],
    [draft, cur, narration, narrationOn],
  )
  // The preview shows text as it's typed and plays the old voice until render, and the narration is auditioned over
  // it, so only other saved changes reload it.
  const previewKey = useMemo(
    () =>
      JSON.stringify(
        (draft?.ops ?? []).filter((o) => o.op !== 'text' && o.op !== 'voice' && o.op !== 'narration'),
      ),
    [draft?.ops],
  )
  const curRef = useRef(cur)
  curRef.current = cur
  const dirty = !!draft && !sameOps(ops, draft.ops)

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
      resetNarration(narrationOf(draft.ops))
    }
  }, [draft, ops])

  // Edits are kept as a draft on the server, so leaving only loses the last moment's changes before they save.
  useEffect(() => {
    if (!dirty && !saving) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
    }
  }, [dirty, saving])

  // Save shortly after the last change.
  useEffect(() => {
    if (!dirty || saving || pictureN !== null) return
    const t = setTimeout(() => void save(), 700)
    return () => {
      clearTimeout(t)
    }
  }, [dirty, saving, save, pictureN])

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
  const setLine = (beat: string, text: string) => {
    update((c) => {
      for (const l of c.narration) if (l.beat === beat) l.text = text
      return c
    })
  }
  /** Back to the version as it was: every field, beat and colour (the save then clears the draft's edits). */
  const revertAll = () => {
    if (!draft) return
    setCur(structuredClone(draft.base))
    resetNarration(null)
    sendRef.current?.({
      type: 'apply-edits',
      edits: draft.base.beats.flatMap((b) => b.texts.map((t) => ({ id: t.id, text: t.text }))),
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
    // A frame that loaded while someone typed shows the text as saved then: bring it up to date.
    const edits = (curRef.current?.beats ?? []).flatMap((b) =>
      b.texts.map((t) => ({ id: t.id, text: t.text })),
    )
    if (edits.length) send({ type: 'apply-edits', edits })
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
  const rebase = async (toN: number) => {
    if (!draft) return
    setRebasing(true)
    const { data, error } = await fetchClient.POST('/api/v1/edits/{id}/rebase-narration', {
      params: { path: { id: draft.id } },
      body: { toN },
    })
    setRebasing(false)
    if (data) void navigate(`/videos/${id}/edit/${toN}`, { state: { narrationReady: true } })
    else showError(error)
  }

  if (problem && !draft)
    return (
      <Alert color="red" variant="light" title="Can't edit this version">
        <Text size="sm">{problem}</Text>
        <Anchor component={Link} to={`/videos/${id}`} size="sm">
          Back to the video
        </Anchor>
      </Alert>
    )
  // Waits for the config too: until it says whether narration is on, a save would drop the draft's narration op.
  if (!draft || !cur || !video.data || config.isPending)
    return <Text c="var(--va-muted)">Opening the editor…</Text>
  const total = cur.beats.reduce((s, b) => s + b.duration, 0)
  // Music, then each voiced beat's line (effects and recorded narration get their own rows later).
  const music = cur.audio.filter((a) => a.role === 'music')
  const lines = cur.narration.filter((l) => cur.beats.some((b) => b.id === l.beat))
  const next = video.data.versions.length + 1
  // The version's values, for "Was: …" under each changed field.
  const base = draft.base
  const baseBeat = new Map(base.beats.map((b) => [b.id, b] as const))
  const baseText = new Map(base.beats.flatMap((b) => b.texts.map((t) => [t.id, t.text] as const)))
  const baseSlot = new Map(base.beats.flatMap((b) => b.media.map((m) => [m.slot, m] as const)))
  const deleted = base.beats.filter((b) => !cur.beats.some((x) => x.id === b.id))
  const kept = base.beats.map((b) => b.id).filter((bid) => cur.beats.some((x) => x.id === bid))
  const reordered = kept.join() !== cur.beats.map((b) => b.id).join()
  // Render asks how when the saved draft has recorded narration (keep the visuals, and what to do past the end).
  const savedNarration = narrationOn ? narrationOf(draft.ops) : null
  const renderBody = (c: RenderChoice) => ({
    params: { path: { id: draft.id }, header: { 'idempotency-key': renderKey } },
    body: { mode: c.mode, ...(c.holdFinalFrame ? { holdFinalFrame: true } : {}) },
  })
  // Recording waits while a pending op would move time in the render (plan 2026-11-02 §5.3).
  const timingPending = timingChanged(ops, base)
  const lockedOut = lock.state.status === 'locked' || lock.state.status === 'taken_over'
  const hint = (
    <Text size="xs" c="var(--va-faint)">
      Click any text in the preview to edit it. Text changes show at once; timing, order, colours, media and
      audio after the draft saves.
    </Text>
  )

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
              {Math.round(total * 10) / 10} s · {cur.beats.length}{' '}
              {cur.beats.length === 1 ? 'scene' : 'scenes'} ·{' '}
              {saving
                ? 'Saving…'
                : dirty
                  ? 'Unsaved changes'
                  : draft.ops.length
                    ? 'Draft saved'
                    : 'No changes yet'}
            </div>
          </div>
          <Group gap="sm">
            <Button
              variant="subtle"
              color="gray"
              leftSection={<IconArrowBackUp size={14} />}
              disabled={!ops.length}
              onClick={revertAll}
            >
              Revert all
            </Button>
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
              disabled={!draft.rev || dirty || saving || pictureN !== null}
              loading={render.isPending}
              onClick={() => {
                if (savedNarration) setRenderDialog(true)
                else
                  render.mutate({
                    params: { path: { id: draft.id }, header: { 'idempotency-key': renderKey } },
                  })
              }}
            >
              Render as v{next}
            </Button>
          </Group>
        </div>

        {resumed ? (
          <Alert color="blue" variant="light" mb="md" data-testid="resume-draft">
            <Group justify="space-between" gap="sm">
              <Text size="sm">
                You have {resumed} unrendered {resumed === 1 ? 'change' : 'changes'} to v{draft.baseN} from
                before. Keep them, or start again from v{draft.baseN}?
              </Text>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => {
                    revertAll()
                    setResumed(0)
                  }}
                >
                  Start over
                </Button>
                <Button
                  size="xs"
                  onClick={() => {
                    setResumed(0)
                  }}
                >
                  Keep my changes
                </Button>
              </Group>
            </Group>
          </Alert>
        ) : null}
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

        {narrationOn ? (
          <NarrationSection
            key={narrationStart.key}
            videoId={id}
            versionN={draft.baseN}
            dimensions={video.data.dimensions}
            draft={{ editId: draft.id, key: previewKey }}
            composition={cur}
            initialOp={narrationStart.op}
            onChange={setNarration}
            onMusicChange={setTrack}
            onPreviewReady={onReady}
            onPreviewClick={onPreviewClick}
            timingPending={timingPending}
            control={narrationControl}
            hint={hint}
            readOnly={lockedOut}
            canRecord={lock.canEdit}
            banner={
              <>
                <NarrationLockBanner
                  state={lock.state}
                  busy={takingOver}
                  onWatch={() => void navigate(`/videos/${id}`)}
                  onTakeOver={() => {
                    setTakingOver(true)
                    void lock.takeOver().finally(() => setTakingOver(false))
                  }}
                />
                {keptMine ? null : (
                  <NarrationStaleBanner
                    changed={draft.narrationChanged}
                    busy={rebasing}
                    onRebase={(toN) => void rebase(toN)}
                    onKeepMine={() => setKeptMine(true)}
                  />
                )}
              </>
            }
            pictureFirst={
              <RenderPictureFirst
                videoId={id}
                editId={draft.id}
                disabled={dirty || saving || !lock.canEdit}
                reason={
                  !lock.canEdit
                    ? 'Recording needs the narration lock.'
                    : dirty || saving
                      ? 'Saving your changes first…'
                      : undefined
                }
                onStarted={setPictureN}
                onReopen={(to) => {
                  void qc.invalidateQueries()
                  void navigate(`/videos/${id}/edit/${to}`, { state: { narrationReady: true } })
                }}
              />
            }
          />
        ) : (
          <>
            <CompositionPreview
              videoId={id}
              versionN={draft.baseN}
              dimensions={video.data.dimensions}
              draft={{ editId: draft.id, key: previewKey }}
              onClick={onPreviewClick}
              onReady={onReady}
            />
            {hint}
          </>
        )}
      </div>
      <div className="va-editor-panel" data-testid="edit-panel">
        <Card>
          <Text fw={600} mb="sm">
            Scenes
          </Text>
          {reordered ? (
            <Was
              value={`order ${base.beats.map((b) => labelFor(b.label, b.id)).join(', ')}`}
              name="scene order"
              onRevert={() => {
                update((c) => {
                  const at = (bid: string) => base.beats.findIndex((b) => b.id === bid)
                  c.beats.sort((a, b) => at(a.id) - at(b.id))
                  return c
                })
              }}
            />
          ) : null}
          {deleted.map((b) => (
            <Group key={b.id} gap={6} wrap="nowrap" data-testid={`deleted-${b.id}`}>
              <Text size="xs" c="var(--va-faint)" style={{ flex: 1 }}>
                Deleted: {labelFor(b.label, b.id)}
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconArrowBackUp size={12} />}
                aria-label={`Restore ${labelFor(b.label, b.id)}`}
                onClick={() => {
                  update((c) => {
                    // Back where it was among the beats still there, as the version had it.
                    const i = base.beats.indexOf(b)
                    const after = c.beats.findIndex((x) => base.beats.findIndex((y) => y.id === x.id) > i)
                    c.beats.splice(after === -1 ? c.beats.length : after, 0, structuredClone(b))
                    return c
                  })
                  sendRef.current?.({
                    type: 'apply-edits',
                    edits: b.texts.map((t) => ({ id: t.id, text: t.text })),
                  })
                }}
              >
                Restore
              </Button>
            </Group>
          ))}
          <Stack gap="sm" mt={reordered || deleted.length ? 'xs' : 0}>
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
                    <Tooltip label="The last scene can't be deleted" disabled={cur.beats.length > 1}>
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
                  {(() => {
                    const was = baseBeat.get(b.id)
                    return was && !sameNumber(was.duration, b.duration) ? (
                      <Was
                        value={`${Math.round(was.duration * 100) / 100} s`}
                        name={`length of ${labelFor(b.label, b.id)}`}
                        onRevert={() => {
                          update((c) => {
                            const x = c.beats.find((y) => y.id === b.id)
                            if (x) x.duration = was.duration
                            return c
                          })
                        }}
                      />
                    ) : null
                  })()}
                  {b.texts.map((t) => {
                    const was = baseText.get(t.id)
                    const label = labelFor(t.label, t.id, b.id)
                    return (
                      <div key={t.id}>
                        <TextInput
                          size="xs"
                          label={label}
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
                        {was !== undefined && was !== t.text ? (
                          <Was
                            value={was}
                            name={label}
                            onRevert={() => {
                              setText(t.id, was)
                            }}
                          />
                        ) : null}
                      </div>
                    )
                  })}
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
                        {(() => {
                          const was = baseSlot.get(m.slot)
                          if (!was) return null
                          const fit = (f: string | null | undefined) => (f === 'cover' ? 'Fill' : 'Fit')
                          const parts = [
                            was.src !== m.src ? fileOf(was.src) : null,
                            fit(was.fit) !== fit(m.fit) ? fit(was.fit) : null,
                          ].filter((x) => x !== null)
                          return parts.length ? (
                            <Was
                              value={parts.join(', ')}
                              name={name}
                              onRevert={() => {
                                setSlot(m.slot, { src: was.src, fit: was.fit })
                              }}
                            />
                          ) : null
                        })()}
                      </div>
                    )
                  })}
                </Stack>
              </div>
            ))}
          </Stack>
        </Card>
        {music.length || lines.length ? (
          <Card data-testid="audio-card">
            <Text fw={600} mb="sm">
              Audio
            </Text>
            <Stack gap="sm">
              {music.map((a) => (
                <AudioRow
                  key={a.id}
                  track={a}
                  was={base.audio.find((x) => x.id === a.id)}
                  item={picked[a.src.split('/').pop() ?? '']}
                  onChange={(patch) => {
                    setTrack(a.id, patch)
                  }}
                  onReplace={() => {
                    setReplacingAudio(a)
                  }}
                />
              ))}
              {lines.length ? (
                <div data-testid="voice-section">
                  <Text size="sm" fw={600} mb={4}>
                    Voice
                  </Text>
                  <Text size="xs" c="var(--va-faint)" mb="xs">
                    Changed lines are spoken again when you render. The preview plays the old voice until
                    then, and a scene grows only if its new line no longer fits.
                  </Text>
                  <Stack gap="xs">
                    {lines.map((l) => {
                      const b = cur.beats.find((x) => x.id === l.beat)
                      return (
                        <VoiceRow
                          key={l.beat}
                          line={l}
                          name={labelFor(b?.label ?? null, l.beat)}
                          was={
                            relined(base, l)
                              ? (base.narration.find((x) => x.beat === l.beat)?.text ?? null)
                              : null
                          }
                          onChange={(text) => {
                            setLine(l.beat, text)
                          }}
                        />
                      )
                    })}
                  </Stack>
                </div>
              ) : null}
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
                {base.colors[role] && base.colors[role].toLowerCase() !== value.toLowerCase() ? (
                  <Tooltip label={`Was ${base.colors[role]}`}>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      ml="auto"
                      leftSection={<ColorSwatch color={base.colors[role]} size={12} />}
                      aria-label={`Revert ${humanize(role)} to ${base.colors[role]}`}
                      onClick={() => {
                        update((x) => ({ ...x, colors: { ...x.colors, [role]: base.colors[role] ?? value } }))
                      }}
                    >
                      Revert
                    </Button>
                  </Tooltip>
                ) : null}
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
      {savedNarration ? (
        <NarrationRenderDialog
          opened={renderDialog}
          onClose={() => setRenderDialog(false)}
          op={savedNarration}
          videoSamples={videoSamples(total)}
          next={next}
          pending={render.isPending}
          onRender={(c) => {
            render.mutate(renderBody(c))
          }}
          onTrim={(clipId, sample) => {
            setRenderDialog(false)
            narrationControl.current?.jumpTo(clipId, sample)
          }}
          warning={keptMine ? keepMineWarning(draft.narrationChanged) : null}
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
