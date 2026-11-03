// Mock mode only (/dev/timeline): the narration timeline on a ten-minute, 200-clip fixture, edited through
// useNarrationEditor (moves, trims, splits, deletes, gain, fades, undo/redo) and listing every callback it gets, for
// development and the Playwright spec. Never in production builds: App.tsx mounts it only when VITE_MOCK is set.
import { Stack, Text, Title } from '@mantine/core'
import { useMemo, useState } from 'react'
import { SAMPLE_RATE, secondsToSamples, type Span } from '../../../src/lib/timeline'
import {
  applyTrackPatch,
  ClipInspector,
  ClipMenu,
  EditorAnnouncer,
  Timeline,
  type TimelineComposition,
  type TrackPatch,
} from '../components/timeline'
import { useNarrationEditor } from '../lib/use-narration-editor'
import { timelineFixture } from './timeline-fixture'

const FPS = 30

const sec = (s: number) => (s / SAMPLE_RATE).toFixed(2)

export default function TimelineDemo() {
  const fixture = useMemo(timelineFixture, [])
  const [tracks, setTracks] = useState(fixture.op.tracks)
  const [composition, setComposition] = useState<TimelineComposition>(fixture.composition)
  const [playhead, setPlayhead] = useState(0)
  const [range, setRange] = useState<Span | null>(null)
  const takeSamples = useMemo(
    () => new Map([...fixture.peaks].map(([id, p]) => [id, p.samples])),
    [fixture.peaks],
  )
  const editor = useNarrationEditor(fixture.op, {
    takeSamples,
    baseSamples: secondsToSamples(composition.duration),
    fps: FPS,
    playhead,
    beats: composition.beats,
  })
  // Track controls aren't clip commands, so the demo keeps them beside the editor's undo stack.
  const op = useMemo(() => ({ ...editor.op, tracks }), [editor.op, tracks])
  const selected = editor.selected
  const [events, setEvents] = useState<string[]>([])
  const log = (line: string) => setEvents((e) => [line, ...e].slice(0, 12))

  const onTrackChange = (patch: TrackPatch) => {
    log(`track ${patch.lane} ${JSON.stringify(patch.set)}`)
    if (patch.lane === 'musicLevel')
      setComposition((c) => ({
        ...c,
        audio: c.audio.map((a) => (a.id === patch.audioId ? { ...a, ...patch.set } : a)),
      }))
    else setTracks((t) => applyTrackPatch(t, patch))
  }

  return (
    <Stack gap="md">
      <div>
        <Title order={1}>Timeline</Title>
        <Text size="sm" c="var(--va-muted)" data-testid="timeline-summary">
          A ten-minute narration of {op.clips.length} clips (mock data).
        </Text>
      </div>
      <Timeline
        op={op}
        composition={composition}
        peaks={fixture.peaks}
        takeSpans={fixture.takeSpans}
        takeNames={fixture.takeNames}
        playhead={playhead}
        selectedClipId={selected}
        range={range}
        onSeek={(s) => {
          log(`seek ${sec(s)}`)
          setPlayhead(s)
        }}
        onTrackChange={onTrackChange}
        onSelectClip={(id) => {
          log(`select ${id ?? 'none'}`)
          editor.setSelected(id)
        }}
        onRangeSelect={(r) => {
          log(r ? `range ${sec(r[0])}-${sec(r[1])}` : 'range none')
          setRange(r)
        }}
        onClipCommand={(c) => {
          if (c.type !== 'pointer' || c.phase !== 'move')
            log(
              `command ${c.type} ${c.type === 'key' ? c.key : c.type === 'menu' ? 'open' : c.phase} ${c.clipId}`,
            )
          editor.onClipCommand(c)
        }}
      />
      <ClipMenu editor={editor} />
      <EditorAnnouncer editor={editor} />
      <ClipInspector editor={editor} />
      <Text size="sm" className="num" data-testid="timeline-playhead-readout">
        Playhead {sec(playhead)} s{range ? ` · range ${sec(range[0])}–${sec(range[1])} s` : ''}
      </Text>
      <ol
        data-testid="timeline-events"
        style={{ margin: 0, fontSize: 12, fontFamily: 'var(--mantine-font-family-monospace)' }}
      >
        {events.map((e, i) => (
          <li key={events.length - i}>{e}</li>
        ))}
      </ol>
    </Stack>
  )
}
