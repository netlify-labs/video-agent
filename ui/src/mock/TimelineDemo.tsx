// Mock mode only (/dev/timeline): the narration timeline on a ten-minute, 200-clip fixture, holding the state the
// editor will hold (op, playhead, selection, range) and listing every callback it gets, for development and the
// Playwright spec. Never in production builds: App.tsx mounts it only when VITE_MOCK is set.
import { Stack, Text, Title } from '@mantine/core'
import { useMemo, useState } from 'react'
import { SAMPLE_RATE, type Span } from '../../../src/lib/timeline'
import { applyTrackPatch, Timeline, type TimelineComposition, type TrackPatch } from '../components/timeline'
import { timelineFixture } from './timeline-fixture'

const sec = (s: number) => (s / SAMPLE_RATE).toFixed(2)

export default function TimelineDemo() {
  const fixture = useMemo(timelineFixture, [])
  const [op, setOp] = useState(fixture.op)
  const [composition, setComposition] = useState<TimelineComposition>(fixture.composition)
  const [playhead, setPlayhead] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [range, setRange] = useState<Span | null>(null)
  const [events, setEvents] = useState<string[]>([])
  const log = (line: string) => setEvents((e) => [line, ...e].slice(0, 12))

  const onTrackChange = (patch: TrackPatch) => {
    log(`track ${patch.lane} ${JSON.stringify(patch.set)}`)
    if (patch.lane === 'musicLevel')
      setComposition((c) => ({
        ...c,
        audio: c.audio.map((a) => (a.id === patch.audioId ? { ...a, ...patch.set } : a)),
      }))
    else setOp((o) => ({ ...o, tracks: applyTrackPatch(o.tracks, patch) }))
  }

  return (
    <Stack gap="md">
      <div>
        <Title order={1}>Timeline</Title>
        <Text size="sm" c="var(--va-muted)">
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
          setSelected(id)
        }}
        onRangeSelect={(r) => {
          log(r ? `range ${sec(r[0])}-${sec(r[1])}` : 'range none')
          setRange(r)
        }}
        onClipCommand={(c) => {
          if (c.type === 'key' || c.phase !== 'move')
            log(`command ${c.type} ${c.type === 'key' ? c.key : c.phase} ${c.clipId}`)
        }}
      />
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
