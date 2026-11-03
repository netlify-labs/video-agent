// The editor's Narration section (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3-§2.5, §5.4, §5.5): the
// composition preview with the narration auditioned over it, and under it the timeline (Scenes, Narration, AI voice,
// Music), the clip tools, the track's settings and Add audio (upload, drop, the library, this video's recordings).
// The op it edits goes up through onChange and is saved with the draft's other ops (one whole-track snapshot); clip
// edits are undoable here, track settings apply as they're set. Slots take the recorder and the narration banners.
// While timing changes are pending, Render picture first takes the recorder's place (§2.1, §5.3); while someone else
// holds the narration lock (§2.7) the track is read-only: it plays and selects, but nothing changes.
import {
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
import { IconChevronDown, IconFileMusic, IconMicrophone, IconPlus } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { FPS } from '../../../src/lib/contract'
import {
  clipEnd,
  SAMPLE_RATE,
  secondsToSamples,
  snapToFrame,
  type AiVoiceMode,
  type NarrationOp,
  type Span,
} from '../../../src/lib/timeline'
import { $api, errorMessage, fetchClient } from '../api/client'
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
import { MediaLibraryModal } from './MediaPicker'
import {
  applyTrackPatch,
  ClipInspector,
  ClipMenu,
  EditorAnnouncer,
  Timeline,
  type TrackPatch,
} from './timeline'

/** What a recorder (va-2qq.3.x, ui/src/recorder) gets to place its takes and follow the picture. */
export interface NarrationTrackApi {
  op: NarrationOp
  editor: NarrationEditor
  /** Composition sample under the playhead, and the ruler's selection (a punch-in range). */
  playhead: number
  range: Span | null
  /** Adds a take to the track at `start` (or the playhead): the whole take, unless a source range is given. */
  insertTake: (
    take: { mediaId: string } & TakeInfo,
    at?: { start?: number; srcStart?: number; srcEnd?: number },
  ) => { ok: boolean; message: string; clipId?: string }
  /** The draft has unsaved or unrendered timing changes: recording waits for Render picture first (§5.3). */
  timingPending: boolean
  /** You hold the narration lock (§2.7): Record is off without it. */
  canRecord: boolean
}

/** What the page can do to the section from outside (the render dialog's Trim). */
export interface NarrationControl {
  /** Selects and shows clip `clipId`, with the playhead at `sample`. */
  jumpTo: (clipId: string, sample: number) => void
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
  onPreviewReady?: (send: (c: PreviewCommand) => void) => void
  onPreviewClick?: (c: { textId: string | null; x: number; y: number }) => void
  timingPending: boolean
  control?: RefObject<NarrationControl | null>
  /** Shown above the timeline: the narration lock and stale-base banners (lane E, ui/src/components/narration). */
  banner?: ReactNode
  /** The recorder (lane C, ui/src/recorder), given the track to place its takes on. */
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
  const [range, setRange] = useState<Span | null>(null)
  const initial = useMemo(() => props.initialOp ?? emptyNarration(), [props.initialOp])
  const [tracks, setTracks] = useState(initial.tracks)
  const [cleanup, setCleanup] = useState(initial.cleanup)
  const [mediaIds, setMediaIds] = useState(() => initial.clips.map((c) => c.mediaId))
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
  const ids = op.clips.map((c) => c.mediaId).join()
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
    (take, at = {}) => {
      takes.add(take.mediaId, take)
      const start = at.start ?? playhead
      const clip = takeClip(freshClipId(editor.op), take.mediaId, take.samples, start)
      const srcStart = at.srcStart ?? 0
      const srcEnd = at.srcEnd ?? clip.srcEnd
      const r = editor.dispatch({ type: 'insert', clip: { ...clip, srcStart, srcEnd } })
      if (!r.ok) notifications.show({ color: 'red', message: r.message })
      return { ...r, clipId: clip.id }
    },
    [editor, playhead, takes],
  )

  const control = props.control
  useEffect(() => {
    if (!control) return
    control.current = {
      jumpTo: (clipId, sample) => {
        seek(sample)
        editor.setSelected(clipId)
        focusClip(clipId)
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
        notifications.show({ color: 'red', message: errorMessage(e) })
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
      notifications.show({ color: 'red', message: errorMessage(e) })
    }
  }
  const [picking, setPicking] = useState<'library' | 'recordings' | null>(null)
  const recordings = $api.useQuery(
    'get',
    '/api/v1/videos/{id}/recordings',
    { params: { path: { id: videoId } } },
    { enabled: picking === 'recordings' },
  )

  const onTrackChange = (patch: TrackPatch) => {
    if (readOnly) return
    if (patch.lane === 'musicLevel') props.onMusicChange(patch.audioId, patch.set)
    else setTracks((t) => applyTrackPatch(t, patch))
  }
  const hasVoice = lanes.beats.some((b) => b.voice)
  const overrun =
    baseSamples > 0 ? Math.max(0, op.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0) - baseSamples) : 0

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
      />
      {props.hint}
      <Card data-testid="narration-section">
        <Group justify="space-between" gap="sm" mb="xs">
          <Group gap={8}>
            <IconMicrophone size={16} />
            <Text fw={600}>Narration</Text>
            {op.clips.length ? (
              <Tooltip label={RAW_DESCRIPTION} multiline w={260}>
                <Badge size="xs" variant="light" color="gray">
                  {RAW_LABEL}
                </Badge>
              </Tooltip>
            ) : null}
          </Group>
          <Group gap="xs">
            <FileButton accept={NARRATION_ACCEPT} multiple onChange={(fs) => void addFiles(fs, playhead)}>
              {(p) => (
                <Button
                  {...p}
                  size="xs"
                  variant="default"
                  leftSection={<IconPlus size={14} />}
                  disabled={!!importing || readOnly}
                  data-testid="narration-upload"
                >
                  Add audio
                </Button>
              )}
            </FileButton>
            <Menu position="bottom-end">
              <Menu.Target>
                <Button
                  size="xs"
                  variant="default"
                  aria-label="Add audio from"
                  rightSection={<IconChevronDown size={14} />}
                  disabled={!!importing || readOnly}
                >
                  From…
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconFileMusic size={14} />} onClick={() => setPicking('library')}>
                  The library
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconMicrophone size={14} />}
                  onClick={() => setPicking('recordings')}
                >
                  Recordings for this video
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
        {props.banner}
        <Text size="xs" c="var(--va-faint)" mb="xs">
          Drop an MP3, M4A, WAV, Ogg or WebM file on the Narration lane, or add one at the playhead. Drag clips to
          line them up; your narration plays over the scenes as they are.
        </Text>
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
        />
        <ClipMenu editor={editor} />
        <EditorAnnouncer editor={editor} />
        <Stack gap="sm" mt="sm">
          <ClipInspector editor={editor} />
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
                timingPending: props.timingPending,
                canRecord: props.canRecord !== false && !readOnly,
              })}
        </Stack>
      </Card>
      {picking === 'library' ? (
        <MediaLibraryModal
          opened
          title="Add audio to the narration"
          kinds={['audio']}
          onClose={() => setPicking(null)}
          onPick={([m]) => {
            setPicking(null)
            if (m) void pick(m.id)
          }}
        />
      ) : null}
      <Modal
        opened={picking === 'recordings'}
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
                      setPicking(null)
                      void pick(m.id)
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
