// Render with recorded narration (docs/plans/2026-11-02-record-your-own-voiceover.md §2.5): where the narration
// starts and ends against the video in a small bar, Keep my visuals preselected with its cost, and when the narration
// runs past the end, what to do about it: trim the clip (jumps to it), hold the last frame (plus 0.5 s), or switch to
// letting the agent fit the video to the narration. Fitting is an authoring run (about 250 credits) that always
// replaces the AI voice (§12 decision 11, said when Keep or Under is set), so it asks once more before it starts.
// After Keep mine on a stale base (§2.7), it warns whose narration the render replaces.
import { Alert, Button, Group, Modal, Radio, Stack, Text } from '@mantine/core'
import { useEffect, useState } from 'react'
import { FPS } from '../../../src/lib/contract'
import { SAMPLE_RATE, type NarrationOp } from '../../../src/lib/timeline'
import { renderPreview, type RenderPreview } from '../lib/narration-panel'
import { formatTime } from '../lib/timeline-view'

/** A render-unchanged run's cost, measured on production (docs/spikes.md S4: 33.6 and 34.4 credits). */
export const KEEP_VISUALS_CREDITS = 34

/**
 * A fit's cost: an authoring run (§2.5, about 250 credits; an authoring run's measured range is roughly 200-300,
 * docs/spikes.md S4).
 */
export const FIT_CREDITS = 250

export type RenderMode = 'keep_visuals' | 'fit_to_narration'
export interface RenderChoice {
  mode: RenderMode
  /** Keep my visuals only: hold the last frame for an overrun. */
  holdFinalFrame: boolean
}

const time = (samples: number) => formatTime(samples / SAMPLE_RATE, 0.1)
/** A length, not a position: "0.8 s". */
const secs = (samples: number) => `${Math.round((samples / SAMPLE_RATE) * 10) / 10} s`
const pct = (v: number, of: number) => `${of > 0 ? Math.min(100, Math.max(0, (v / of) * 100)) : 0}%`

/** The narration against the video: the picture's span, the narration's, and what a held frame would add. */
function DurationBar({ p, hold, fit }: { p: RenderPreview; hold: boolean; fit: boolean }) {
  const span = Math.max(p.video, p.end, hold ? p.holdEnd : 0)
  return (
    <div data-testid="render-duration-bar">
      <div className="va-render-bar" aria-hidden>
        <div className="va-render-bar-video" style={{ width: pct(p.video, span) }} />
        {hold && p.overflow ? (
          <div
            className="va-render-bar-hold"
            style={{ left: pct(p.video, span), width: pct(p.holdEnd - p.video, span) }}
          />
        ) : null}
        {Math.min(p.end, p.video) > p.start ? (
          <div
            className="va-render-bar-narration"
            style={{ left: pct(p.start, span), width: pct(Math.min(p.end, p.video) - p.start, span) }}
          />
        ) : null}
        {p.overflow ? (
          <div
            className="va-render-bar-narration"
            data-over=""
            style={{
              left: pct(Math.max(p.start, p.video), span),
              width: pct(p.end - Math.max(p.start, p.video), span),
            }}
          />
        ) : null}
      </div>
      <Group justify="space-between" mt={4}>
        <Text size="xs" c="var(--va-faint)" className="num">
          Narration {time(p.start)}–{time(p.end)}
        </Text>
        <Text size="xs" c="var(--va-faint)" className="num">
          Video {time(p.video)}
          {hold && p.overflow ? ` · with the held frame ${time(p.holdEnd)}` : ''}
          {fit ? ` · fitted ${time(p.fitEnd)}` : ''}
        </Text>
      </Group>
    </div>
  )
}

export function NarrationRenderDialog(props: {
  opened: boolean
  onClose: () => void
  op: NarrationOp
  /** The visuals' length in samples. */
  videoSamples: number
  /** The version this renders as. */
  next: number
  pending: boolean
  onRender: (choice: RenderChoice) => void
  /** Trim: close and show the clip that runs past the end, with the playhead at the video's end. */
  onTrim: (clipId: string, sample: number) => void
  /** Keep mine on a stale base: whose narration this replaces (keepMineWarning). */
  warning?: string | null
}) {
  const p = renderPreview(props.op, props.videoSamples, FPS)
  const over = p.overflow > 0
  // Keep my visuals is preselected; an overrun then needs a choice: hold the last frame (when that fits in the
  // limit), switch to fitting, or trim. A fit asks once more, for its cost, before it starts.
  const [mode, setMode] = useState<RenderMode>('keep_visuals')
  const [choice, setChoice] = useState<'hold' | null>(null)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!props.opened) return
    setMode('keep_visuals')
    setChoice(null)
    setConfirming(false)
  }, [props.opened])
  const fit = mode === 'fit_to_narration' && p.fitAllowed
  const hold = !fit && over && p.holdAllowed && choice === 'hold'
  const canRender = fit || !over || hold
  const aiVoice = props.op.tracks.aiVoice.mode
  const overflowChoice: string | null = hold ? 'hold' : null
  return (
    <Modal opened={props.opened} onClose={props.onClose} title={`Render as v${props.next}`} size="lg">
      <Stack gap="md">
        {props.warning ? (
          <Alert color="orange" variant="light" data-testid="render-warning">
            <Text size="sm">{props.warning}</Text>
          </Alert>
        ) : null}
        <DurationBar p={p} hold={hold} fit={fit} />
        <Radio.Group
          value={fit ? 'fit_to_narration' : 'keep_visuals'}
          onChange={(v) => {
            setMode(v)
            setConfirming(false)
          }}
          label="How to render"
          name="render-mode"
        >
          <Stack gap="xs" mt={6}>
            <Radio
              value="keep_visuals"
              disabled={confirming}
              label="Keep my visuals"
              description={`Your narration plays over the scenes as they are. About ${KEEP_VISUALS_CREDITS} credits.`}
            />
            <Radio
              value="fit_to_narration"
              disabled={!p.fitAllowed || confirming}
              label="Let the agent fit the video to my narration"
              description={
                p.fitAllowed
                  ? `An authoring run, about ${FIT_CREDITS} credits: the agent retimes, extends or tightens the scenes so the video ends half a second after your last word (${time(p.fitEnd)}). It can't change your narration.`
                  : p.end > 0
                    ? `That would make the video ${time(p.fitEnd)}, longer than it can be (${time(p.limit)}). Trim the narration first.`
                    : 'None of your narration is audible, so there is nothing to fit to.'
              }
            />
          </Stack>
        </Radio.Group>
        {fit && aiVoice !== 'replace' ? (
          <Alert color="blue" variant="light" data-testid="render-fit-ai-voice">
            <Text size="sm">
              Fitting always replaces the AI voice-over with yours. Your AI voice setting (
              {aiVoice === 'keep' ? 'Keep' : 'Under my voice'}) applies only when you keep your visuals.
            </Text>
          </Alert>
        ) : null}
        {over && !fit ? (
          <Alert color="yellow" variant="light" data-testid="render-overflow">
            <Text size="sm" mb="xs">
              Your narration runs {secs(p.overflow)} past the end of the video.
            </Text>
            <Radio.Group
              value={overflowChoice}
              onChange={(v) => {
                if (v === 'fit') setMode('fit_to_narration')
                else setChoice('hold')
              }}
              name="render-overflow"
              label="What should happen to the rest?"
            >
              <Stack gap="xs">
                <Radio
                  value="hold"
                  disabled={!p.holdAllowed}
                  label={`Hold the last frame until it ends (the video becomes ${time(p.holdEnd)})`}
                  description={
                    p.holdAllowed
                      ? 'A still of the last frame, plus half a second after your last word.'
                      : `That's longer than this video can be (${time(p.limit)}). Trim the narration instead.`
                  }
                />
                <Radio
                  value="fit"
                  disabled={!p.fitAllowed}
                  label="Switch to fitting the video to my narration"
                  description={`The agent stretches the scenes to it: about ${FIT_CREDITS} credits.`}
                />
              </Stack>
            </Radio.Group>
            <Button
              mt="sm"
              size="xs"
              variant="default"
              onClick={() => {
                if (p.overflowClipId) props.onTrim(p.overflowClipId, p.video)
              }}
            >
              Trim the clip instead
            </Button>
          </Alert>
        ) : null}
        {confirming ? (
          <Alert color="grape" variant="light" data-testid="render-fit-confirm">
            <Text size="sm" fw={600}>
              Start an authoring run of about {FIT_CREDITS} credits?
            </Text>
            <Text size="sm" mt={4}>
              The agent fits v{props.next} to your narration ({time(p.fitEnd)}): it may retime, extend or
              tighten any scene, and replaces the AI voice-over with yours. Your narration stays exactly as it
              is.
            </Text>
            <Group justify="flex-end" gap="sm" mt="sm">
              <Button
                variant="subtle"
                color="gray"
                onClick={() => {
                  setConfirming(false)
                }}
              >
                Back
              </Button>
              <Button
                loading={props.pending}
                onClick={() => {
                  props.onRender({ mode: 'fit_to_narration', holdFinalFrame: false })
                }}
              >
                Start fitting (about {FIT_CREDITS} credits)
              </Button>
            </Group>
          </Alert>
        ) : (
          <Group justify="flex-end" gap="sm">
            <Button variant="subtle" color="gray" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              disabled={!canRender}
              loading={props.pending}
              onClick={() => {
                if (fit) setConfirming(true)
                else props.onRender({ mode: 'keep_visuals', holdFinalFrame: hold })
              }}
            >
              Render as v{props.next}
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  )
}
