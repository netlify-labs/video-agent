// The Review state of the Record a take panel (record flow): a stopped take plays against the picture before it goes
// on the timeline. The narration plays as Add would leave it (review.ts reviewOp: a punch-in's pre-roll and the
// narration around it, the range replaced), through the editor's narration audition, kept on the panel's muted picture
// by its currentTime. Under the prompter: play/pause, a scrubber over the review, the take's length, where it lands,
// why it stopped, and Add (Enter), Record again, Keep recording from here, Discard (Esc).
import { ActionIcon, Alert, Button, Group, Slider, Stack, Text, Tooltip } from '@mantine/core'
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import type { NarrationOp, Span } from '../../../src/lib/timeline'
import { log } from '../lib/log'
import { NarrationAudition } from '../lib/narration-audition'
import type { Review } from './flow'
import { reviewSpan, tenths } from './review'

export interface TakeReviewProps {
  review: Review
  /** The panel's picture (muted MP4). */
  video: HTMLVideoElement | null
  /** The narration as Add would leave it; null while the take is still being finalized. */
  op: NarrationOp | null
  takeSamples: ReadonlyMap<string, number>
  takeSpans?: ReadonlyMap<string, readonly Span[]>
  loadTake: (mediaId: string) => Promise<ArrayBuffer>
  /** Why it stopped early, in words (null when Space or the end stopped it). */
  stopNotice: string | null
  /** Upload status while it isn't done, else null. */
  uploadNote: string | null
  /** Record again and Keep recording need the upload done (one take uploads at a time). */
  canRestart: boolean
  /** Where the picture ends (seconds): Keep recording from here shows when the take stops before it. */
  pictureEnd: number | null
  adding: boolean
  onAdd: () => void
  onAgain: () => void
  onContinue: () => void
  onDiscard: () => void
}

/** A take that ends this close to the picture's end reached the end (no Keep recording from here). */
const END_SLACK_SEC = 0.25

export function TakeReview(p: TakeReviewProps) {
  const span = reviewSpan(p.review)
  const [time, setTime] = useState(span.from)
  const [playing, setPlaying] = useState(false)
  const engine = useRef<NarrationAudition | null>(null)
  const load = useRef(p.loadTake)
  load.current = p.loadTake
  const spanRef = useRef(span)
  spanRef.current = span

  useEffect(() => {
    const e = new NarrationAudition({ loadTake: (id) => load.current(id), log })
    engine.current = e
    return () => {
      e.dispose()
      engine.current = null
    }
  }, [])
  useEffect(() => {
    engine.current?.setOp(p.op, p.takeSamples)
  }, [p.op, p.takeSamples])

  // Cue the picture at the review's start (a new take, or Record again's next one).
  useEffect(() => {
    const v = p.video
    if (!v) return
    v.pause()
    v.currentTime = spanRef.current.from
    engine.current?.seek(spanRef.current.from)
    setTime(spanRef.current.from)
    setPlaying(false)
  }, [p.video, p.review.recordingId])

  // While playing, the picture is the clock: the narration follows it, and the review stops at the take's end.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const v = p.video
      if (!v) return
      const t = v.currentTime
      engine.current?.clock(t)
      setTime(t)
      if (t >= spanRef.current.to || v.ended) {
        pause()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, p.video])

  function pause() {
    p.video?.pause()
    engine.current?.pause()
    setPlaying(false)
  }
  async function play() {
    const v = p.video
    const e = engine.current
    if (!v || !e) return
    const at = time >= span.to - 0.05 ? span.from : time
    v.currentTime = at
    setTime(at)
    // Started in the click (the audition's context may start), then the picture.
    await e.play(at)
    try {
      await v.play()
    } catch {
      e.pause()
      return
    }
    setPlaying(true)
  }
  function scrub(t: number) {
    if (playing) pause()
    if (p.video) p.video.currentTime = t
    engine.current?.seek(t)
    setTime(t)
  }

  const short = p.pictureEnd !== null && span.end < p.pictureEnd - END_SLACK_SEC
  const ready = p.op !== null
  return (
    <Stack gap="xs" data-testid="take-review" data-recording={p.review.recordingId}>
      <Group gap="sm" wrap="nowrap" align="center">
        <Tooltip label={playing ? 'Pause' : 'Play the take with the picture'}>
          <ActionIcon
            variant="filled"
            size="lg"
            radius="xl"
            aria-label={playing ? 'Pause the take' : 'Play the take'}
            disabled={!ready || p.adding}
            onClick={() => (playing ? pause() : void play())}
            data-testid="review-play"
          >
            {playing ? <IconPlayerPauseFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
          </ActionIcon>
        </Tooltip>
        <Slider
          style={{ flex: 1 }}
          min={span.from}
          max={Math.max(span.to, span.from + 0.01)}
          step={0.01}
          value={Math.min(Math.max(time, span.from), span.to)}
          onChange={scrub}
          label={(v) => tenths(v)}
          disabled={!ready || p.adding}
          thumbLabel="Review position"
          data-testid="review-scrub"
        />
        <Text size="sm" className="num" data-testid="review-time">
          {tenths(time)}
        </Text>
      </Group>
      <Text size="sm" data-testid="review-summary">
        {p.review.joined ? 'The joined take' : p.review.punch ? 'The punch-in' : 'The take'} is{' '}
        <span className="num">{(span.end - span.start).toFixed(1)} s</span> long and lands at{' '}
        <span className="num" data-testid="review-lands">
          {tenths(span.start)} to {tenths(span.end)}
        </span>
        {p.review.punch && !p.review.joined ? ', with its pre-roll before it' : ''}.
        {p.uploadNote ? ` ${p.uploadNote}` : ''}
      </Text>
      {p.stopNotice ? (
        <Alert color="yellow" variant="light" data-testid="review-stop" data-early={p.review.early}>
          {p.stopNotice}
        </Alert>
      ) : null}
      <Group gap="xs">
        <Button size="xs" onClick={p.onAdd} loading={p.adding} data-testid="review-add">
          Add to timeline (Enter)
        </Button>
        <Tooltip label="Once the take has uploaded" disabled={p.canRestart}>
          <Button
            size="xs"
            variant="default"
            disabled={!p.canRestart || p.adding}
            onClick={p.onAgain}
            data-testid="review-again"
          >
            Record again
          </Button>
        </Tooltip>
        {short ? (
          <Tooltip label="Once the take has uploaded" disabled={p.canRestart}>
            <Button
              size="xs"
              variant="default"
              disabled={!p.canRestart || p.adding}
              onClick={p.onContinue}
              data-testid="review-continue"
            >
              Keep recording from {tenths(span.end)}
            </Button>
          </Tooltip>
        ) : null}
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          disabled={p.adding}
          onClick={p.onDiscard}
          data-testid="review-discard"
        >
          Discard (Esc)
        </Button>
      </Group>
    </Stack>
  )
}
