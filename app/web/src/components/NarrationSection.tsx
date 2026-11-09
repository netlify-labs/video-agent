// The editor's Narration section (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3-§2.5, §5.4, §5.5): the
// composition preview with the narration auditioned over it, and under it the timeline (Scenes, Narration, AI voice,
// Music), the clip tools, the track's settings and Add audio (upload, drop, the library, this video's recordings, Find
// music). Each track's + adds to that track, and the Add audio button asks which track; a music file sets the music bed
// (owner, 2026-11-06).
// The op it edits goes up through onChange and is saved with the draft's other ops (one whole-track snapshot); clip
// edits are undoable here, track settings apply as they're set. Slots take the recorder (NarrationRecorder) and the
// narration banners.
// While timing changes are pending, Render picture first takes the recorder's place (§2.1, §5.3); while someone else
// holds the narration lock (§2.7) the track is read-only: it plays and selects, but nothing changes.
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  FileButton,
  Group,
  Menu,
  Modal,
  Progress,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconChevronDown,
  IconFileMusic,
  IconMicrophone,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconUpload,
} from '@tabler/icons-react'
import { useNavigate } from 'react-router'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { FPS } from '../../../server/lib/contract'
import {
  clipLength,
  clipEnd,
  opTakeIds,
  SAMPLE_RATE,
  secondsToSamples,
  snapToFrame,
  type AiVoiceMode,
  type Fit,
  type NarrationOp,
  type NarrationTracks,
  type Span,
} from '../../../server/lib/timeline'
import { $api, fetchClient } from '../api/client'
import {
  APPROX_CLEANUP_DESCRIPTION,
  APPROX_CLEANUP_LABEL,
  RAW_DESCRIPTION,
  RAW_LABEL,
} from '../lib/narration-audition'
import { importNarrationFile, isNarrationFile, NARRATION_ACCEPT } from '../lib/narration-import'
import {
  emptyNarration,
  freshClipId,
  isEmptyNarration,
  takeClip,
  timelineComposition,
  voicesFromHtml,
  type EditorComposition,
} from '../lib/narration-panel'
import { voicePlacements } from '../lib/narration-voice-align'
import { formatTime } from '../lib/timeline-view'
import { useNarrationAudition } from '../lib/use-narration-audition'
import { focusClip, useNarrationEditor, type NarrationEditor } from '../lib/use-narration-editor'
import { useNarrationTakes, type TakeInfo } from '../lib/use-narration-takes'
import { CompositionPreview, type PreviewCommand } from './CompositionPreview'
import { AlignToVoice } from './AlignToVoice'
import { showError } from './bits'
import { FindMusicModal } from './FindMusic'
import { MediaLibraryModal, type Media } from './MediaPicker'
import { defaultTarget, type AddTarget } from '../lib/add-target'
import { uploadFile } from '../lib/upload'
import { ClipTakeDownload } from './TakeDownload'
import { takeNumber } from '../lib/take-download'
import {
  applyTrackPatch,
  ClipInspector,
  ClipMenu,
  EditorAnnouncer,
  Timeline,
  type TimelineProps,
  type TrackPatch,
} from './timeline'

/** Where a take goes: composition `start` (or the playhead), a source range, and a recorded take's sync fit. */
/** How to add narration; on the Add audio button (the lane says "Drop an audio file here" itself). */
const DROP_HELP =
  'Add an MP3, M4A, WAV, Ogg or WebM file at the playhead, or drop one on the Narration lane. Drag clips to line them up; your narration plays over the scenes as they are.'

export interface TakePlacement {
  start?: number
  srcStart?: number
  srcEnd?: number
  fit?: Fit
  offsetSamples?: number
}

/** What a recorder (NarrationRecorder, app/web/src/recorder) gets to place its takes and follow the picture. */
export interface NarrationTrackApi {
  op: NarrationOp
  editor: NarrationEditor
  /** Composition sample under the playhead, and the ruler's selection (a punch-in range). */
  playhead: number
  range: Span | null
  /**
   * Adds a take to the track at `start` (or the playhead): the whole take, unless a source range is given. A list
   * adds one clip per piece (a recorded take's fit segments) as one undo step. With `keepTakes` (a punch-in), what
   * the new clips cover stays as their take alternatives. `op` is the op with them in it.
   */
  insertTake: (
    take: { mediaId: string } & TakeInfo,
    at?: TakePlacement | readonly TakePlacement[],
    opts?: { keepTakes?: boolean },
  ) => { ok: boolean; message: string; clipId?: string; op?: NarrationOp }
  /** Sets the track settings a take records with (the setup panel's Original audio). */
  setTracks: (patch: Partial<NarrationTracks>) => void
  /** Saves the draft with `op` as its narration; throws when the save fails. */
  saveDraft: (op: NarrationOp) => Promise<void>
  /** Opens the Add audio file picker (Upload instead). */
  openUpload: () => void
  /** The draft's composition as the preview plays it (the monitor's stems and the teleprompter's lines). */
  html: string | null
  takeSamples: ReadonlyMap<string, number>
  takeSpans: ReadonlyMap<string, readonly Span[]>
  /** The draft has unsaved or unrendered timing changes: recording waits for Render picture first (§5.3). */
  timingPending: boolean
  /** You hold the narration lock (§2.7): Record is off without it. */
  canRecord: boolean
  /** Bumped by the Narration track's + > Record: the recorder opens its panel. */
  openRequest: number
}

/** What the page can do to the section from outside (the render dialog's Trim). */
export interface NarrationControl {
  /** Selects and shows clip `clipId`, with the playhead at `sample`. */
  jumpTo: (clipId: string, sample: number) => void
  /** Moves the playhead (and the preview) to `seconds` into the composition. */
  seekTo: (seconds: number) => void
  /** Where the playhead is, in seconds. */
  time: () => number
  /** The timeline's clips, in order (WebMCP's list and select, va-qago). */
  clips: () => { id: string; start: number; seconds: number }[]
  /** Selects a clip, as clicking it does; false when there's no such clip. */
  select: (clipId: string | null) => boolean
  /** The timeline's own undo and redo (its buttons and shortcuts); false when there's nothing to undo or redo. */
  undo: () => boolean
  redo: () => boolean
}

export interface NarrationSectionProps {
  videoId: string
  versionN: number
  dimensions: { width: number; height: number }
  /** The draft: its preview, and the key that reloads it after a save it can't show live. */
  draft: { editId: string; key: string }
  /** The composition being edited (beats and audio, live). */
  composition: EditorComposition
  /** The draft's narration op when it opened (or after a reset); null for a new track. */
  initialOp: NarrationOp | null
  onChange: (op: NarrationOp) => void
  /** The music layer's own level and mute (an audio op on the page). */
  onMusicChange: (audioId: string, patch: { volume?: number; muted?: boolean }) => void
  /** Sets the music bed to a ready library item (a music op on the page); without it the Music track takes nothing. */
  onSetMusic?: (m: Media) => void
  onPreviewReady?: (send: (c: PreviewCommand) => void) => void
  onPreviewClick?: (c: { textId: string | null; x: number; y: number }) => void
  timingPending: boolean
  control?: RefObject<NarrationControl | null>
  /** Shown above the timeline: the narration lock and stale-base banners (lane E, app/web/src/components/narration). */
  banner?: ReactNode
  /** Saves the draft with this narration op now (a recorded take's clip); throws when the save fails. */
  onSaveDraft?: (op: NarrationOp) => Promise<void>
  /** The timeline's scene menu (redo a scene), passed through. */
  sceneMenu?: TimelineProps['sceneMenu']
  /** The recorder (NarrationRecorder), given the track to place its takes on. */
  recorder?: (api: NarrationTrackApi) => ReactNode
  /** Shown in the recorder's place while timingPending: Render picture first (RenderPictureFirst). */
  pictureFirst?: ReactNode
  /** Someone else holds the narration lock: the track plays and selects, but nothing on it changes. */
  readOnly?: boolean
  /** Record needs the narration lock (false while someone else holds it). */
  canRecord?: boolean
  /** A hint under the preview. */
  hint?: ReactNode
}

const MODES: { value: AiVoiceMode; label: string }[] = [
  { value: 'replace', label: 'Replace' },
  { value: 'under', label: 'Under my voice' },
  { value: 'keep', label: 'Keep' },
]

const MODE_NOTES: Record<AiVoiceMode, string> = {
  replace: "The AI voice-over is muted under your narration. It's kept, so you can bring it back.",
  under: 'The AI voice-over plays under yours, at the AI voice level.',
  keep: 'The AI voice-over plays as it is, alongside yours.',
}

const LOCKED_MESSAGE = 'Someone else is editing the narration. Take over to change it.'

/** Waits for an upload to be ready in the library (the music bed takes ready items only). */
async function readyMedia(id: string, timeoutMs = 120_000): Promise<Media> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const { data } = await fetchClient.GET('/api/v1/media/{id}', { params: { path: { id } } })
    if (data?.status === 'ready') return data
    if (data?.status === 'rejected') throw new Error(`${data.filename} couldn't be used.`)
    if (Date.now() > until)
      throw new Error('The file is still being checked. Pick it from the library in a moment.')
    await new Promise((r) => setTimeout(r, 1000))
  }
}

interface Importing {
  name: string
  percent: number
  phase: string
}

export function NarrationSection(props: NarrationSectionProps) {
  const { videoId, draft, composition } = props
  const me = $api.useQuery('get', '/api/v1/me')

  // The draft's composition as the preview plays it, read for the AI voice clips' timing and the music's dip.
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    const run = { gone: false }
    void (async () => {
      const { data } = await fetchClient.GET('/api/v1/edits/{id}/preview', {
        params: { path: { id: draft.editId } },
      })
      if (!data) return
      const res = await fetch(data.url).catch(() => null)
      if (res?.ok && !run.gone) setHtml(await res.text())
    })()
    return () => {
      run.gone = true
    }
  }, [draft.editId, draft.key])
  const voices = useMemo(() => voicesFromHtml(html), [html])
  const lanes = useMemo(() => timelineComposition(composition, voices), [composition, voices])
  const baseSamples = secondsToSamples(lanes.duration)

  const [playhead, setPlayhead] = useState(0)
  const playheadRef = useRef(0)
  playheadRef.current = playhead
  const [range, setRange] = useState<Span | null>(null)
  const initial = useMemo(() => props.initialOp ?? emptyNarration(), [props.initialOp])
  const [tracks, setTracks] = useState(initial.tracks)
  const [cleanup, setCleanup] = useState(initial.cleanup)
  const [mediaIds, setMediaIds] = useState(() => opTakeIds(initial.clips))
  const takes = useNarrationTakes(mediaIds)
  const live = useNarrationEditor(initial, {
    takeSamples: takes.takeSamples,
    baseSamples,
    fps: FPS,
    playhead,
    beats: lanes.beats,
    readOnly: props.readOnly === true,
  })
  // Read-only: every command is refused (selection and the playhead still move, so the track can be watched).
  const readOnly = props.readOnly === true
  const editor = useMemo<NarrationEditor>(
    () =>
      readOnly
        ? {
            ...live,
            dispatch: () => ({ ok: false, message: LOCKED_MESSAGE }),
            onClipCommand: () => undefined,
            undo: () => undefined,
            redo: () => undefined,
            canUndo: false,
            canRedo: false,
          }
        : live,
    [live, readOnly],
  )
  // Track settings aren't clip commands: they sit beside the editor's undo stack, as on a mixing desk.
  const op = useMemo<NarrationOp>(() => ({ ...editor.op, tracks, cleanup }), [editor.op, tracks, cleanup])
  // Alternatives' takes too: a swap needs their length and peaks.
  const ids = opTakeIds(op.clips).join()
  useEffect(() => {
    setMediaIds(ids ? ids.split(',') : [])
  }, [ids])
  const onChange = useRef(props.onChange)
  onChange.current = props.onChange
  useEffect(() => {
    onChange.current(op)
  }, [op])

  const audition = useNarrationAudition({
    op: isEmptyNarration(op) ? null : op,
    takeSamples: takes.takeSamples,
    takeSpans: takes.takeSpans,
    html,
  })
  const send = useRef<((c: PreviewCommand) => void) | null>(null)
  const { onReady: auditionReady, onMessage: auditionMessage, onTransport } = audition.previewProps
  const onPreviewReady = props.onPreviewReady
  const onReady = useCallback(
    (s: (c: PreviewCommand) => void) => {
      send.current = s
      onPreviewReady?.(s)
      auditionReady(s)
    },
    [onPreviewReady, auditionReady],
  )
  const onMessage = useCallback(
    (m: Parameters<typeof auditionMessage>[0]) => {
      auditionMessage(m)
      if (m.type === 'time') setPlayhead(snapToFrame(secondsToSamples(m.time), FPS))
    },
    [auditionMessage],
  )
  const seek = useCallback(
    (sample: number) => {
      setPlayhead(sample)
      const time = sample / SAMPLE_RATE
      send.current?.({ type: 'seek', time })
      onTransport({ type: 'seek', time })
    },
    [onTransport],
  )

  const insertTake = useCallback<NarrationTrackApi['insertTake']>(
    (take, at = {}, opts = {}) => {
      takes.add(take.mediaId, take)
      const pieces = Array.isArray(at) ? (at as readonly TakePlacement[]) : [at as TakePlacement]
      const taken = new Set<string>()
      const clips = pieces.map((p) => {
        const id = freshClipId(editor.op, taken)
        taken.add(id)
        const clip = takeClip(id, take.mediaId, take.samples, p.start ?? playhead)
        return {
          ...clip,
          srcStart: p.srcStart ?? 0,
          srcEnd: p.srcEnd ?? clip.srcEnd,
          ...(p.fit ? { fit: p.fit } : {}),
          ...(p.offsetSamples !== undefined ? { offsetSamples: p.offsetSamples } : {}),
        }
      })
      const [first, ...rest] = clips
      if (!first) return { ok: false, message: 'Nothing to add' }
      const r = editor.dispatch({
        type: 'insert',
        clip: first,
        ...(rest.length ? { with: rest } : {}),
        ...(opts.keepTakes ? { keepTakes: true } : {}),
      })
      if (!r.ok) notifications.show({ color: 'red', message: r.message })
      return { ...r, clipId: first.id, ...(r.op ? { op: { ...r.op, tracks, cleanup } } : {}) }
    },
    [editor, playhead, takes, tracks, cleanup],
  )
  const setTrackSettings = useCallback(
    (patch: Partial<NarrationTracks>) => {
      if (!readOnly) setTracks((t) => ({ ...t, ...patch }))
    },
    [readOnly],
  )
  const onSaveDraft = props.onSaveDraft
  const saveDraft = useCallback(async (o: NarrationOp) => onSaveDraft?.(o), [onSaveDraft])
  const uploadButton = useRef<HTMLButtonElement | null>(null)
  const openUpload = useCallback(() => uploadButton.current?.click(), [])

  const control = props.control
  useEffect(() => {
    if (!control) return
    control.current = {
      jumpTo: (clipId, sample) => {
        seek(sample)
        editor.setSelected(clipId)
        focusClip(clipId)
      },
      seekTo: (seconds) => {
        seek(Math.max(0, Math.round(seconds * SAMPLE_RATE)))
      },
      time: () => playheadRef.current / SAMPLE_RATE,
      clips: () =>
        editor.op.clips.map((c) => ({
          id: c.id,
          start: c.start / SAMPLE_RATE,
          seconds: clipLength(c) / SAMPLE_RATE,
        })),
      select: (clipId) => {
        if (clipId !== null && !editor.op.clips.some((c) => c.id === clipId)) return false
        editor.setSelected(clipId)
        if (clipId) focusClip(clipId)
        return true
      },
      undo: () => {
        if (!editor.canUndo) return false
        editor.undo()
        return true
      },
      redo: () => {
        if (!editor.canRedo) return false
        editor.redo()
        return true
      },
    }
  }, [control, seek, editor])

  // ---- adding audio: files (dropped or chosen), the library, this video's recordings

  const [importing, setImporting] = useState<Importing | null>(null)
  // The one file just added, offered Align to AI voice (§2.4) until it's used or dismissed.
  const [aligning, setAligning] = useState<{ clipId: string; mono: Float32Array } | null>(null)
  const addFiles = async (files: File[], start: number) => {
    if (readOnly) {
      notifications.show({ color: 'yellow', message: LOCKED_MESSAGE })
      return
    }
    const audio = files.filter(isNarrationFile)
    for (const f of files.filter((x) => !isNarrationFile(x)))
      notifications.show({ color: 'red', message: `${f.name} isn't an MP3, M4A, WAV, Ogg or WebM file.` })
    let at = start
    for (const f of audio) {
      setImporting({ name: f.name, percent: 0, phase: 'Reading' })
      try {
        const take = await importNarrationFile(f, {
          scopeJobId: videoId,
          userId: me.data?.id,
          onProgress: (p) => {
            setImporting({
              name: f.name,
              percent: p.total ? Math.round((p.sent / p.total) * 100) : 0,
              phase: p.phase === 'decoding' ? 'Reading' : p.phase === 'checking' ? 'Checking' : 'Uploading',
            })
          },
        })
        const r = insertTake(take, { start: at })
        // Several files land one after another.
        if (r.ok) at += take.samples
        setAligning(
          audio.length === 1 && r.ok && r.clipId && take.mono ? { clipId: r.clipId, mono: take.mono } : null,
        )
      } catch (e) {
        showError(e)
      }
    }
    setImporting(null)
  }
  const pick = async (mediaId: string) => {
    try {
      const info = await takes.ensure(mediaId)
      if (!info.samples) throw new Error("That audio's length isn't known yet. Try again in a moment.")
      insertTake({ mediaId, ...info })
    } catch (e) {
      showError(e)
    }
  }
  // What's being picked from, and for which track (null: Add audio, which asks which track once there's an item).
  const [picking, setPicking] = useState<{
    from: 'library' | 'recordings' | 'find'
    to: AddTarget | null
  } | null>(null)
  const recordings = $api.useQuery(
    'get',
    '/api/v1/videos/{id}/recordings',
    { params: { path: { id: videoId } } },
    { enabled: picking?.from === 'recordings' },
  )
  // The selected track: the last one added to, or the narration when a clip is selected. Add audio defaults to it.
  const [selectedTrack, setSelectedTrack] = useState<AddTarget>('narration')
  useEffect(() => {
    if (editor.selected) setSelectedTrack('narration')
  }, [editor.selected])
  const canMusic = !!props.onSetMusic && !readOnly
  const setMusic = (m: Media) => {
    if (!props.onSetMusic) return
    if (readOnly) {
      notifications.show({ color: 'yellow', message: LOCKED_MESSAGE })
      return
    }
    props.onSetMusic(m)
    setSelectedTrack('music')
    notifications.show({ message: `${m.source?.title ?? m.filename} is the music now.` })
  }
  const uploadMusic = async (files: File[]) => {
    const f = files.find(isNarrationFile)
    if (!f) {
      notifications.show({ color: 'red', message: "That isn't an MP3, M4A, WAV, Ogg or WebM file." })
      return
    }
    if (files.length > 1) notifications.show({ message: `The music is one file: using ${f.name}.` })
    setImporting({ name: f.name, percent: 0, phase: 'Uploading' })
    try {
      const id = await uploadFile(f, {
        onProgress: (p) => {
          setImporting({
            name: f.name,
            percent: p.total ? Math.round((p.sent / p.total) * 100) : 0,
            phase: p.phase === 'checking' ? 'Checking' : 'Uploading',
          })
        },
      })
      setImporting({ name: f.name, percent: 100, phase: 'Checking' })
      setMusic(await readyMedia(id))
    } catch (e) {
      showError(e)
    }
    setImporting(null)
  }
  // Add audio asks which track an item goes to.
  const [asking, setAsking] = useState<{
    what: string
    to: AddTarget
    music: boolean
    add: (to: AddTarget) => void
  } | null>(null)
  const addMedia = (m: Media, to: AddTarget | null, prefer?: AddTarget) => {
    const go = (t: AddTarget) => (t === 'music' ? setMusic(m) : void pick(m.id))
    // A take or a recording made for this video is narration, never the music bed.
    const music = canMusic && !m.role
    if (to) go(to)
    else
      setAsking({
        what: m.source?.title ?? m.filename,
        to: music ? (prefer ?? defaultTarget(m, selectedTrack)) : 'narration',
        music,
        add: go,
      })
  }
  const askFiles = (files: File[]) => {
    if (!files.length) return
    setAsking({
      what: files.length === 1 ? (files[0]?.name ?? 'the file') : `${files.length} files`,
      to: canMusic ? selectedTrack : 'narration',
      music: canMusic,
      add: (t) => (t === 'music' ? void uploadMusic(files) : void addFiles(files, playhead)),
    })
  }
  const musicUpload = useRef<HTMLButtonElement | null>(null)
  const askUpload = useRef<HTMLButtonElement | null>(null)
  const [openRequest, setOpenRequest] = useState(0)
  const navigate = useNavigate()

  const onTrackChange = (patch: TrackPatch) => {
    if (readOnly) return
    if (patch.lane === 'musicLevel') props.onMusicChange(patch.audioId, patch.set)
    else setTracks((t) => applyTrackPatch(t, patch))
  }
  const hasVoice = lanes.beats.some((b) => b.voice)
  const overrun =
    baseSamples > 0 ? Math.max(0, op.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0) - baseSamples) : 0

  // Hidden file pickers the menus press: narration (at the playhead), the music bed, and Add audio's (which asks).
  const filePickers = (
    <>
      <FileButton accept={NARRATION_ACCEPT} multiple onChange={(fs) => void addFiles(fs, playhead)}>
        {(p) => (
          <button {...p} ref={uploadButton} type="button" hidden tabIndex={-1} aria-hidden>
            Upload
          </button>
        )}
      </FileButton>
      <FileButton accept={NARRATION_ACCEPT} onChange={(f) => f && void uploadMusic([f])}>
        {(p) => (
          <button {...p} ref={musicUpload} type="button" hidden tabIndex={-1} aria-hidden>
            Upload music
          </button>
        )}
      </FileButton>
      <FileButton accept={NARRATION_ACCEPT} multiple onChange={askFiles}>
        {(p) => (
          <button {...p} ref={askUpload} type="button" hidden tabIndex={-1} aria-hidden>
            Upload audio
          </button>
        )}
      </FileButton>
    </>
  )

  // One Add audio menu in the row under the timeline (the timeline sits right under the picture): upload a file,
  // pick from the library, find music, or reuse a recording made for this video; it then asks which track.
  const addAudio = (
    <Group gap={6} wrap="nowrap">
      {filePickers}
      <Menu position="bottom-start">
        <Menu.Target>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconPlus size={14} />}
            rightSection={<IconChevronDown size={14} />}
            disabled={!!importing || readOnly}
            data-testid="narration-upload"
            title={DROP_HELP}
          >
            Add audio
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconUpload size={14} />} onClick={() => askUpload.current?.click()}>
            Upload a file
          </Menu.Item>
          <Menu.Item
            leftSection={<IconFileMusic size={14} />}
            onClick={() => setPicking({ from: 'library', to: null })}
          >
            From the library
          </Menu.Item>
          {canMusic ? (
            <Menu.Item
              leftSection={<IconSearch size={14} />}
              onClick={() => setPicking({ from: 'find', to: null })}
            >
              Find music
            </Menu.Item>
          ) : null}
          <Menu.Item
            leftSection={<IconMicrophone size={14} />}
            onClick={() => setPicking({ from: 'recordings', to: null })}
          >
            Recordings for this video
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {op.clips.length ? (
        <Tooltip label={RAW_DESCRIPTION} multiline w={260}>
          <Badge size="xs" variant="light" color="gray">
            {RAW_LABEL}
          </Badge>
        </Tooltip>
      ) : null}
    </Group>
  )

  // Each track's +, with what fits that track.
  const plus = (name: string, items: ReactNode, disabled = false) => (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label={`Add to ${name}`}
          data-testid={`track-add-${name.toLowerCase().replace(/\s+/g, '-')}`}
          disabled={disabled}
        >
          <IconPlus size={14} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown aria-label={`Add to ${name}`}>{items}</Menu.Dropdown>
    </Menu>
  )
  const recordable = !!props.recorder && props.canRecord !== false && !readOnly && !props.timingPending
  const addMenus: TimelineProps['addMenus'] = {
    narration: plus(
      'Narration',
      <>
        <Menu.Item
          leftSection={<IconMicrophone size={14} />}
          disabled={!recordable}
          onClick={() => {
            setSelectedTrack('narration')
            setOpenRequest((n) => n + 1)
          }}
        >
          Record
        </Menu.Item>
        <Menu.Item leftSection={<IconUpload size={14} />} onClick={openUpload}>
          Upload a file
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFileMusic size={14} />}
          onClick={() => setPicking({ from: 'library', to: 'narration' })}
        >
          From the library
        </Menu.Item>
        <Menu.Item
          leftSection={<IconMicrophone size={14} />}
          onClick={() => setPicking({ from: 'recordings', to: 'narration' })}
        >
          Recordings for this video
        </Menu.Item>
      </>,
      !!importing || readOnly,
    ),
    music: canMusic
      ? plus(
          'Music',
          <>
            <Menu.Item
              leftSection={<IconSearch size={14} />}
              onClick={() => setPicking({ from: 'find', to: 'music' })}
            >
              Find music
            </Menu.Item>
            <Menu.Item
              leftSection={<IconFileMusic size={14} />}
              onClick={() => setPicking({ from: 'library', to: 'music' })}
            >
              From the library
            </Menu.Item>
            <Menu.Item leftSection={<IconUpload size={14} />} onClick={() => musicUpload.current?.click()}>
              Upload a file
            </Menu.Item>
          </>,
          !!importing,
        )
      : null,
    aiVoice: plus(
      'AI voice',
      <Menu.Item leftSection={<IconSparkles size={14} />} onClick={() => void navigate(`/videos/${videoId}`)}>
        Generate (ask for a revision with AI voice-over)
      </Menu.Item>,
    ),
  }

  return (
    <>
      <CompositionPreview
        videoId={videoId}
        versionN={props.versionN}
        dimensions={props.dimensions}
        draft={draft}
        {...(props.onPreviewClick ? { onClick: props.onPreviewClick } : {})}
        onReady={onReady}
        onMessage={onMessage}
        onTransport={onTransport}
        note={false}
      />
      {props.hint}
      <Card data-testid="narration-section" p="sm">
        {props.banner}
        {importing ? (
          <Stack gap={4} mb="xs" data-testid="narration-importing">
            <Text size="xs">
              {importing.phase} {importing.name}…
            </Text>
            <Progress size="sm" value={importing.percent} animated />
          </Stack>
        ) : null}
        {aligning && hasVoice ? (
          <AlignToVoice
            editId={draft.editId}
            voices={voicePlacements(lanes)}
            clipId={aligning.clipId}
            mono={aligning.mono}
            op={op}
            dispatch={editor.dispatch}
            onDone={() => setAligning(null)}
          />
        ) : null}
        <Timeline
          op={op}
          composition={lanes}
          peaks={takes.peaks}
          takeSpans={takes.takeSpans}
          takeNames={takes.names}
          playhead={playhead}
          selectedClipId={editor.selected}
          range={range}
          onSeek={seek}
          onTrackChange={onTrackChange}
          onSelectClip={editor.setSelected}
          onRangeSelect={setRange}
          onClipCommand={editor.onClipCommand}
          onDropFiles={(files, at) => void addFiles(files, at)}
          {...(canMusic ? { onDropMusic: (files: File[]) => void uploadMusic(files) } : {})}
          addMenus={addMenus}
          {...(props.sceneMenu ? { sceneMenu: props.sceneMenu } : {})}
        />
        <ClipMenu editor={editor} />
        <EditorAnnouncer editor={editor} />
        <Stack gap="sm" mt="sm">
          <ClipInspector
            editor={editor}
            start={addAudio}
            end={(clip) => (
              <ClipTakeDownload
                videoId={videoId}
                versionN={props.versionN}
                mediaId={clip.mediaId}
                take={takeNumber(
                  editor.op.clips.map((c) => c.mediaId),
                  clip.mediaId,
                )}
              />
            )}
          />
          <Group gap="lg" align="end" wrap="wrap">
            <Stack gap={4}>
              <Text size="xs" c="var(--va-muted)">
                AI voice
              </Text>
              <SegmentedControl
                size="xs"
                aria-label="AI voice"
                disabled={!hasVoice || readOnly}
                value={tracks.aiVoice.mode}
                onChange={(v) => {
                  setTracks((t) => ({ ...t, aiVoice: { ...t.aiVoice, mode: v } }))
                }}
                data={MODES}
              />
            </Stack>
            <Stack gap={4}>
              <Text size="xs" c="var(--va-muted)">
                Cleanup
              </Text>
              <SegmentedControl
                size="xs"
                aria-label="Cleanup"
                disabled={readOnly}
                value={cleanup}
                onChange={(v) => {
                  setCleanup(v === 'off' ? 'off' : 'light')
                }}
                data={[
                  { value: 'light', label: 'Light' },
                  { value: 'off', label: 'Off' },
                ]}
              />
            </Stack>
            <Switch
              size="xs"
              label="Mute all original audio"
              disabled={readOnly}
              checked={tracks.original.muteAll}
              onChange={(e) => {
                const muteAll = e.currentTarget.checked
                setTracks((t) => ({ ...t, original: { muteAll } }))
              }}
            />
            <Tooltip label={APPROX_CLEANUP_DESCRIPTION}>
              <Switch
                size="xs"
                label={APPROX_CLEANUP_LABEL}
                disabled={cleanup === 'off' || !op.clips.length}
                checked={audition.approxCleanup && cleanup !== 'off'}
                onChange={(e) => {
                  audition.setApproxCleanup(e.currentTarget.checked)
                }}
              />
            </Tooltip>
          </Group>
          {hasVoice || overrun > 0 ? (
            <Text size="xs" c="var(--va-faint)" data-testid="narration-note">
              {hasVoice ? MODE_NOTES[tracks.aiVoice.mode] : ''}
              {overrun > 0
                ? `${hasVoice ? ' ' : ''}Your narration runs ${Math.round((overrun / SAMPLE_RATE) * 10) / 10} s past the end of the video; Render asks what to do with it.`
                : ''}
            </Text>
          ) : null}
          {props.timingPending && props.pictureFirst
            ? props.pictureFirst
            : props.recorder?.({
                op,
                editor,
                playhead,
                range,
                insertTake,
                setTracks: setTrackSettings,
                saveDraft,
                openUpload,
                html,
                takeSamples: takes.takeSamples,
                takeSpans: takes.takeSpans,
                timingPending: props.timingPending,
                canRecord: props.canRecord !== false && !readOnly,
                openRequest,
              })}
        </Stack>
      </Card>
      {picking?.from === 'library' ? (
        <MediaLibraryModal
          opened
          title={
            picking.to === 'music'
              ? 'Set the music'
              : picking.to === 'narration'
                ? 'Add audio to the narration'
                : 'Add audio'
          }
          kinds={['audio']}
          onClose={() => setPicking(null)}
          onPick={([m]) => {
            const to = picking.to
            setPicking(null)
            if (m) addMedia(m, to)
          }}
        />
      ) : null}
      {canMusic ? (
        <FindMusicModal
          opened={picking?.from === 'find'}
          onClose={() => setPicking(null)}
          onImported={(m) => {
            // Find music's results are music: Add audio still asks, with Music chosen.
            const to = picking?.to ?? null
            setPicking(null)
            if (to) setMusic(m)
            else addMedia(m, null, 'music')
          }}
        />
      ) : null}
      <Modal opened={!!asking} onClose={() => setAsking(null)} title={`Add ${asking?.what ?? ''}`} size="sm">
        {asking ? (
          <Stack gap="sm" data-testid="add-to">
            <Text size="sm">Add to:</Text>
            <SegmentedControl
              aria-label="Add to"
              value={asking.to}
              onChange={(v) => setAsking({ ...asking, to: v })}
              data={[
                { value: 'narration', label: 'Narration' },
                { value: 'music', label: 'Music', disabled: !asking.music },
              ]}
            />
            <Text size="xs" c="var(--va-faint)">
              {asking.to === 'music'
                ? 'It becomes the music bed for the whole video, and dips under the voice-over.'
                : 'It goes on the Narration track at the playhead.'}
            </Text>
            <Group justify="flex-end" gap="xs">
              <Button size="xs" variant="default" onClick={() => setAsking(null)}>
                Cancel
              </Button>
              <Button
                size="xs"
                data-testid="add-to-confirm"
                onClick={() => {
                  setAsking(null)
                  asking.add(asking.to)
                }}
              >
                Add
              </Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>
      <Modal
        opened={picking?.from === 'recordings'}
        onClose={() => setPicking(null)}
        title="Recordings for this video"
      >
        <Stack gap="xs">
          {recordings.isPending ? (
            <Text size="sm" c="var(--va-muted)">
              Loading…
            </Text>
          ) : !recordings.data?.items.length ? (
            <Text size="sm" c="var(--va-muted)">
              No recordings for this video yet. Takes you record or upload here are kept for 30 days.
            </Text>
          ) : (
            recordings.data.items
              .filter((m) => m.status === 'ready')
              .map((m) => (
                <Group key={m.id} justify="space-between" wrap="nowrap" gap="sm">
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" truncate>
                      {m.title ?? m.filename}
                    </Text>
                    <Text size="xs" c="var(--va-faint)" className="num">
                      {m.durationSec ? formatTime(m.durationSec, 0.1) : ''}
                    </Text>
                  </div>
                  <Button
                    size="compact-xs"
                    variant="default"
                    aria-label={`Add ${m.title ?? m.filename}`}
                    onClick={() => {
                      const to = picking?.to
                      setPicking(null)
                      // A recording made for this video is narration: Add audio still asks, with Music off.
                      if (to) void pick(m.id)
                      else
                        setAsking({
                          what: m.title ?? m.filename,
                          to: 'narration',
                          music: false,
                          add: () => void pick(m.id),
                        })
                    }}
                  >
                    Add
                  </Button>
                </Group>
              ))
          )}
        </Stack>
      </Modal>
    </>
  )
}
