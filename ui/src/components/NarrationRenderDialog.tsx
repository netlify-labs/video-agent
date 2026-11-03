// Render with recorded narration (docs/plans/2026-11-02-record-your-own-voiceover.md §2.5): where the narration
// starts and ends against the video in a small bar, Keep my visuals preselected with its cost, and when the narration
// runs past the end, what to do about it: trim the clip (jumps to it), hold the last frame (plus 0.5 s), or let the
// agent fit the video to the narration (coming in a later release).
import { Alert, Badge, Button, Group, Modal, Radio, Stack, Text } from '@mantine/core'
import { useEffect, useState } from 'react'
import { FPS } from '../../../src/lib/contract'
import { SAMPLE_RATE, type NarrationOp } from '../../../src/lib/timeline'
import { renderPreview, type RenderPreview } from '../lib/narration-panel'
import { formatTime } from '../lib/timeline-view'

/** A render-unchanged run's cost, measured on production (docs/spikes.md S4: 33.6 and 34.4 credits). */
export const KEEP_VISUALS_CREDITS = 34

export interface RenderChoice {
  mode: 'keep_visuals'
  holdFinalFrame: boolean
}

const time = (samples: number) => formatTime(samples / SAMPLE_RATE, 0.1)
/** A length, not a position: "0.8 s". */
const secs = (samples: number) => `${Math.round((samples / SAMPLE_RATE) * 10) / 10} s`
const pct = (v: number, of: number) => `${of > 0 ? Math.min(100, Math.max(0, (v / of) * 100)) : 0}%`

/** The narration against the video: the picture's span, the narration's, and what a held frame would add. */
function DurationBar({ p, hold }: { p: RenderPreview; hold: boolean }) {
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
}) {
  const p = renderPreview(props.op, props.videoSamples, FPS)
  const over = p.overflow > 0
  // An overrun needs a choice: hold the last frame (when that fits in the limit), or trim (fitting comes later).
  const [choice, setChoice] = useState<'hold' | null>(null)
  useEffect(() => {
    if (props.opened) setChoice(null)
  }, [props.opened])
  const hold = over && p.holdAllowed && choice === 'hold'
  const canRender = !over || hold
  return (
    <Modal opened={props.opened} onClose={props.onClose} title={`Render as v${props.next}`} size="lg">
      <Stack gap="md">
        <DurationBar p={p} hold={hold} />
        <Radio.Group value="keep_visuals" label="How to render" name="render-mode">
          <Stack gap="xs" mt={6}>
            <Radio
              value="keep_visuals"
              label="Keep my visuals"
              description={`Your narration plays over the scenes as they are. About ${KEEP_VISUALS_CREDITS} credits.`}
            />
            <Radio
              value="fit_to_narration"
              disabled
              label={
                <Group gap={6}>
                  Let the agent fit the video to my narration
                  <Badge size="xs" variant="light" color="gray">
                    Coming soon
                  </Badge>
                </Group>
              }
              description="An authoring run (about 250 credits) that retimes the scenes to your narration."
            />
          </Stack>
        </Radio.Group>
        {over ? (
          <Alert color="yellow" variant="light" data-testid="render-overflow">
            <Text size="sm" mb="xs">
              Your narration runs {secs(p.overflow)} past the end of the video.
            </Text>
            <Radio.Group
              value={hold ? 'hold' : null}
              onChange={() => {
                setChoice('hold')
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
                  disabled
                  label="Switch to fitting the video to my narration"
                  description="Coming soon."
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
        <Group justify="flex-end" gap="sm">
          <Button variant="subtle" color="gray" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canRender}
            loading={props.pending}
            onClick={() => {
              props.onRender({ mode: 'keep_visuals', holdFinalFrame: hold })
            }}
          >
            Render as v{props.next}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
