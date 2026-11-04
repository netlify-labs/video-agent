// The calibration panel (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1 Calibration, §5.3): the clap-on-flash
// test with its flash target and progress, the optional speaker loopback, the result, and the always-available manual
// Sync offset ± slider. Standalone: the setup panel (va-2qq.4.x) places it and passes the route and a listener for the
// armed mic. It prompts when the route has no calibration yet, and reports the offsets placeRecordedTake takes.
import { Alert, Badge, Box, Button, Group, Progress, Slider, Stack, Text, Title } from '@mantine/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { log } from '../../lib/log'
import {
  CalibrationStore,
  clapCalibration,
  DEFAULT_CALIBRATION,
  latencyToOffsetSamples,
  msToOffsetSamples,
  routeKey,
  type AudioRoute,
  type CalibrationOutcome,
  type StoredCalibration,
} from './calibration'
import type { ClapListener } from './listeners'

export interface CalibrationOffsets {
  calibrationOffsetSamples: number
  manualOffsetSamples: number
  /** Their sum: the clip's offsetSamples. */
  offsetSamples: number
}

export interface CalibrationPanelProps {
  route: AudioRoute
  store?: CalibrationStore
  /** Hears claps on the armed mic (micClapListener); null disables the clap test. */
  listener: ClapListener | null
  /** Candidate (a), offered when given (it needs speakers). */
  loopback?: (() => Promise<CalibrationOutcome>) | null
  /** Overrides for the procedure's timing (tests and the demo run it fast). */
  procedure?: Partial<Pick<typeof DEFAULT_CALIBRATION, 'flashes' | 'intervalMs' | 'leadInMs' | 'flashMs'>>
  /** The take's manual offset in ms when the panel edits a take (audition); else the route's last one. */
  manualMs?: number
  onChange?: (offsets: CalibrationOffsets) => void
  onCalibrated?: (c: StoredCalibration) => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; shown: number; of: number }
  | { kind: 'loopback' }
  | { kind: 'failed'; matched: number; of: number }

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function CalibrationPanel({
  route,
  store: given,
  listener,
  loopback,
  procedure,
  manualMs: manualProp,
  onChange,
  onCalibrated,
}: CalibrationPanelProps) {
  const store = useMemo(() => given ?? new CalibrationStore(), [given])
  const key = routeKey(route)
  const [saved, setSaved] = useState(() => store.get(route))
  const [manual, setManual] = useState(manualProp ?? saved.manualMs)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const flashRef = useRef<HTMLDivElement | null>(null)
  const cancelled = useRef(false)
  // Read through a function: the flag flips while the loop awaits.
  const isCancelled = () => cancelled.current
  const p = { ...DEFAULT_CALIBRATION, ...procedure }

  // A different route has its own calibration, or none: re-read and prompt.
  useEffect(() => {
    const s = store.get(route)
    store.noteRoute(route)
    setSaved(s)
    setManual(manualProp ?? s.manualMs)
    setPhase({ kind: 'idle' })
    // Keyed on the route's key, not the object's identity.
  }, [key, store])
  useEffect(() => {
    if (manualProp !== undefined) setManual(manualProp)
  }, [manualProp])

  const emit = useCallback(
    (c: StoredCalibration | null, ms: number) => {
      const calibrationOffsetSamples = c ? latencyToOffsetSamples(c.latencyMs) : 0
      const manualOffsetSamples = msToOffsetSamples(ms)
      onChange?.({ calibrationOffsetSamples, manualOffsetSamples, offsetSamples: calibrationOffsetSamples + manualOffsetSamples })
    },
    [onChange],
  )
  useEffect(() => emit(saved.calibration, manual), [emit, saved.calibration, manual])

  const finish = (route_: AudioRoute, out: CalibrationOutcome) => {
    if (!out.ok) {
      log('calibration.failed', { route: routeKey(route_), matched: out.matched, of: out.of })
      setPhase({ kind: 'failed', matched: out.matched, of: out.of })
      return
    }
    const c = store.save(route_, out.result)
    log('calibration.saved', { route: routeKey(route_), ...out.result })
    setSaved(store.get(route_))
    setPhase({ kind: 'idle' })
    onCalibrated?.(c)
  }

  async function runClaps() {
    if (!listener) return
    cancelled.current = false
    const runRoute = route
    const shown: number[] = []
    setPhase({ kind: 'running', shown: 0, of: p.flashes })
    log('calibration.start', { route: key, method: 'clap', flashes: p.flashes })
    await listener.start()
    const t0 = performance.now() + p.leadInMs
    for (let k = 0; k < p.flashes && !isCancelled(); k++) {
      const due = t0 + k * p.intervalMs
      while (performance.now() < due - 8 && !isCancelled()) await sleep(Math.min(50, due - 8 - performance.now()))
      let now = await nextFrame()
      while (now < due && !isCancelled()) now = await nextFrame()
      const el = flashRef.current
      if (el) {
        el.dataset.flash = 'on'
        el.style.setProperty('--va-flash', '#fff')
      }
      // The style set in this frame is on screen by the next frame's callback.
      const at = await nextFrame()
      shown.push(at)
      listener.flash?.(at)
      setPhase({ kind: 'running', shown: k + 1, of: p.flashes })
      await sleep(p.flashMs)
      if (el) {
        el.dataset.flash = 'off'
        el.style.removeProperty('--va-flash')
      }
    }
    await sleep(Math.min(DEFAULT_CALIBRATION.matchWindowMs[1], p.intervalMs / 2))
    const claps = await listener.stop()
    if (isCancelled()) {
      setPhase({ kind: 'idle' })
      return
    }
    finish(runRoute, clapCalibration(shown, claps, { intervalMs: p.intervalMs }))
  }

  async function runLoopback() {
    if (!loopback) return
    const runRoute = route
    setPhase({ kind: 'loopback' })
    log('calibration.start', { route: key, method: 'loopback' })
    finish(runRoute, await loopback())
  }

  const setManualMs = (ms: number) => {
    setManual(ms)
    if (manualProp === undefined) store.setManual(route, ms)
  }

  const c = saved.calibration
  const busy = phase.kind === 'running' || phase.kind === 'loopback'
  const range = DEFAULT_CALIBRATION.manualRangeMs
  return (
    <Stack gap="sm" data-testid="calibration-panel" data-route={key}>
      <Group gap="xs">
        <Title order={4}>Sync calibration</Title>
        {DEFAULT_CALIBRATION.provisional ? (
          <Badge size="sm" variant="light" color="gray">
            provisional
          </Badge>
        ) : null}
      </Group>
      {!c && !busy ? (
        <Alert data-testid="calibration-prompt" variant="light" title="Calibrate this microphone">
          This is a new audio route. Clap on each flash ({p.flashes} times) so your takes line up with the picture, or
          set the offset by hand below. Bluetooth adds delay and lowers mic quality; wired is best.
        </Alert>
      ) : null}
      <Group align="center" gap="md">
        <Box
          ref={flashRef}
          role="img"
          aria-label="Flash target"
          data-flash="off"
          w={96}
          h={96}
          style={{
            // The flash sets --va-flash directly (frame-exact, outside React's render).
            background: 'var(--va-flash, var(--mantine-color-dark-8))',
            borderRadius: 8,
            border: '1px solid var(--mantine-color-default-border)',
          }}
        />
        <Stack gap={6} style={{ flex: 1 }}>
          {phase.kind === 'running' ? (
            <>
              <Text size="sm">
                Clap on each flash: {phase.shown} of {phase.of}
              </Text>
              <Progress value={(phase.shown / phase.of) * 100} aria-label="Calibration progress" />
            </>
          ) : phase.kind === 'loopback' ? (
            <Text size="sm">Playing clicks through your speakers…</Text>
          ) : (
            <Text size="sm" data-testid="calibration-result">
              {c
                ? `Latency ${Math.round(c.latencyMs)} ms (±${c.sdMs.toFixed(1)} ms, ${c.n} ${c.method === 'clap' ? 'claps' : 'clicks'})`
                : 'Not calibrated.'}
            </Text>
          )}
          {phase.kind === 'failed' ? (
            <Text size="sm" c="red" data-testid="calibration-failed">
              Heard {phase.matched} of {phase.of}. Try again, or set the offset by hand below.
            </Text>
          ) : null}
          <Group gap="xs">
            {busy && phase.kind === 'running' ? (
              <Button size="xs" variant="default" onClick={() => (cancelled.current = true)}>
                Cancel
              </Button>
            ) : (
              <Button size="xs" onClick={() => void runClaps()} disabled={!listener || busy}>
                {c ? 'Recalibrate' : 'Start clap test'}
              </Button>
            )}
            {loopback ? (
              <Button size="xs" variant="default" onClick={() => void runLoopback()} disabled={busy}>
                Speaker test
              </Button>
            ) : null}
          </Group>
        </Stack>
      </Group>
      <Stack gap={4}>
        <Group justify="space-between">
          <Text size="sm" fw={500} id="va-sync-offset-label">
            Sync offset ±
          </Text>
          <Text size="sm" c="dimmed" data-testid="sync-offset-value">
            {manual > 0 ? `+${manual}` : manual} ms{manual ? (manual > 0 ? ' (later)' : ' (earlier)') : ''}
          </Text>
        </Group>
        <Slider
          thumbLabel="Sync offset"
          min={-range}
          max={range}
          step={1}
          value={manual}
          onChange={setManualMs}
          label={(v) => `${v} ms`}
          marks={[{ value: -range }, { value: 0 }, { value: range }]}
        />
      </Stack>
    </Stack>
  )
}
