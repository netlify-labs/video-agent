// Align to AI voice (docs/plans/2026-11-02-record-your-own-voiceover.md §2.4, phase 6): after a file is added to the
// Narration track, a button that compares it with the draft's AI voice and suggests where it starts; the person
// confirms with Use (one undo step) or dismisses it. Nothing moves on its own.
import { Button, Group, Text } from '@mantine/core'
import { IconWaveSine } from '@tabler/icons-react'
import { useState } from 'react'
import type { AlignSuggestion } from '../../../src/lib/narration-align'
import { SAMPLE_RATE, type NarrationOp } from '../../../src/lib/timeline'
import { fetchClient } from '../api/client'
import { log } from '../lib/log'
import { browserDecoder, type Decoder } from '../lib/narration-decode'
import { formatTime } from '../lib/timeline-view'
import type { NarrationEditor } from '../lib/use-narration-editor'
import { alignCommand, loadVoiceStems, suggestFor, type VoicePlacement } from '../lib/narration-voice-align'

export interface AlignToVoiceProps {
  editId: string
  voices: readonly VoicePlacement[]
  /** The clip just added and its take's decoded samples (24 kHz mono). */
  clipId: string
  mono: Float32Array
  op: NarrationOp
  dispatch: NarrationEditor['dispatch']
  onDone: () => void
  decode?: Decoder
}

type State =
  { phase: 'idle' } | { phase: 'working' } | { phase: 'found'; s: AlignSuggestion } | { phase: 'none' }

export function AlignToVoice(props: AlignToVoiceProps) {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const clip = props.op.clips.find((c) => c.id === props.clipId)
  if (!clip || !props.voices.length) return null

  const run = async () => {
    setState({ phase: 'working' })
    const t0 = performance.now()
    try {
      const { data } = await fetchClient.GET('/api/v1/edits/{id}/preview', {
        params: { path: { id: props.editId } },
      })
      if (!data) throw new Error('no preview')
      const stems = await loadVoiceStems(data.url, props.voices, props.decode ?? browserDecoder)
      // Let the spinner paint before the (bounded, sub-second) correlation.
      await new Promise((r) => setTimeout(r, 0))
      const s = stems.length ? suggestFor(props.mono, stems, clip) : null
      log('narration.align.suggested', {
        clipId: clip.id,
        stems: stems.length,
        start: s?.start ?? null,
        score: s ? Math.round(s.score * 100) / 100 : null,
        refined: s?.refined ?? null,
        ms: Math.round(performance.now() - t0),
      })
      setState(s ? { phase: 'found', s } : { phase: 'none' })
    } catch (e) {
      log('narration.align.failed', { clipId: clip.id, error: e instanceof Error ? e.message : String(e) })
      setState({ phase: 'none' })
    }
  }

  return (
    <Group gap="xs" mb="xs" wrap="wrap" data-testid="narration-align">
      {state.phase === 'found' ? (
        <>
          <Text size="xs" data-testid="narration-align-suggestion">
            Matches the AI voice from {formatTime(Math.max(0, state.s.start) / SAMPLE_RATE, 0.1)}
            {state.s.start < 0
              ? ` (trims ${formatTime(-state.s.start / SAMPLE_RATE, 0.1)} at the start)`
              : ''}
          </Text>
          <Button
            size="compact-xs"
            onClick={() => {
              const r = props.dispatch(alignCommand(clip, state.s))
              log('narration.align.applied', { clipId: clip.id, start: state.s.start, ok: r.ok })
              props.onDone()
            }}
          >
            Use
          </Button>
          <Button size="compact-xs" variant="subtle" onClick={props.onDone}>
            Dismiss
          </Button>
        </>
      ) : state.phase === 'none' ? (
        <>
          <Text size="xs" c="var(--va-muted)">
            No clear match with the AI voice. Drag the clip to line it up.
          </Text>
          <Button size="compact-xs" variant="subtle" onClick={props.onDone}>
            OK
          </Button>
        </>
      ) : (
        <>
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconWaveSine size={14} />}
            loading={state.phase === 'working'}
            onClick={() => void run()}
          >
            Align to AI voice
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={props.onDone}
            disabled={state.phase === 'working'}
          >
            Not now
          </Button>
        </>
      )}
    </Group>
  )
}
