// The teleprompter's lines and timing (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1 step 3, §5.3, owner
// decision 10). Pure: the panel (Teleprompter.tsx) asks this what to show at a picture time.
//
// - Text: the AI voice-over script when there is one (versions.voiceover.script, one line per beat in order; or the
//   bundle's script.json lines by beat id, as read() gives them), otherwise each beat's on-screen texts from read()
//   on the base composition. A beat with neither has no line. The held final frame (va-hold) never has one.
// - Timing: locked to the picture. A line is current from its beat's start to its end; the next line shows, dimmed,
//   NEXT_LEAD_SEC before its beat starts.
import { HOLD_BEAT, load, read, type Composition } from '../../../../src/lib/contract'
import { MONITOR_ANCHORS, pictureOffsetFrom } from '../clock/monitor-schedule'
import type { Anchor } from '../clock/picture'

/** The next line appears this long before its beat. */
export const NEXT_LEAD_SEC = 0.5
/** An anchor older than this means the picture has stopped: the prompter holds its last frame's time. */
export const STALE_ANCHOR_MS = 250

export interface PrompterLine {
  beat: string
  /** Composition seconds [start, end) of the beat. */
  start: number
  end: number
  text: string
  source: 'script' | 'beat-text'
}

/** The voice-over script: versions.voiceover.script (by beat, in order) or lines by beat id. */
export type PrompterScript = readonly string[] | Readonly<Record<string, string>>

/** A composition as read() gives it, or its html (read here; unparseable html has no beats). */
export function compositionOf(c: Composition | string): Composition | null {
  if (typeof c !== 'string') return c
  try {
    return read(load(c))
  } catch {
    return null
  }
}

/**
 * Script lines by beat id. A list maps to the beats in order; when its length matches the voiced beats rather than
 * all of them (a script for the narrated beats only), it maps to the voiced beats.
 */
function scriptByBeat(comp: Composition, script: PrompterScript | null | undefined): Map<string, string> {
  const beats = comp.beats.filter((b) => b.id !== HOLD_BEAT)
  if (!script) return new Map(comp.narration.map((l) => [l.beat, l.text]))
  if (!Array.isArray(script)) return new Map(Object.entries(script as Readonly<Record<string, string>>))
  const list = script as readonly string[]
  const voiced = beats.filter((b) => b.voice)
  const targets = list.length !== beats.length && list.length === voiced.length ? voiced : beats
  return new Map(targets.flatMap((b, i) => (list[i] === undefined ? [] : [[b.id, list[i]] as const])))
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The prompter's lines, one per beat that has text, in beat order. */
export function prompterLines(
  composition: Composition | string,
  script?: PrompterScript | null,
): PrompterLine[] {
  const comp = compositionOf(composition)
  if (!comp) return []
  const lines = scriptByBeat(comp, script)
  const out: PrompterLine[] = []
  for (const b of comp.beats) {
    if (b.id === HOLD_BEAT) continue
    const said = clean(lines.get(b.id) ?? '')
    const shown = b.texts.map((t) => clean(t.text)).filter(Boolean)
    const text = said || shown.join(' · ')
    if (!text) continue
    out.push({
      beat: b.id,
      start: b.start,
      end: b.start + b.duration,
      text,
      source: said ? 'script' : 'beat-text',
    })
  }
  return out
}

export interface PrompterState {
  /** The line whose beat is on screen, highlighted; null between lines. */
  current: number | null
  /** The following line, shown dimmed once its beat is NEXT_LEAD_SEC away; null otherwise. */
  next: number | null
}

/** What the prompter shows at composition second `time`. */
export function linesAt(lines: readonly PrompterLine[], time: number, lead = NEXT_LEAD_SEC): PrompterState {
  let current: number | null = null
  let next: number | null = null
  for (const [i, l] of lines.entries()) {
    if (time >= l.start && time < l.end) current = i
    else if (l.start > time) {
      if (l.start - time <= lead) next = i
      break
    }
  }
  return { current, next }
}

/**
 * The composition time on screen at perf `now` from the picture's anchors: now plus the median picture offset over
 * the last MONITOR_ANCHORS (fewer early in a take). When the newest anchor is older than STALE_ANCHOR_MS the picture
 * has stopped, so it's that anchor's time. Null before any anchor.
 */
export function pictureTime(anchors: readonly Anchor[], now: number): number | null {
  const last = anchors[anchors.length - 1]
  if (!last) return null
  if (now - last.now > STALE_ANCHOR_MS) return last.mediaTime
  const offset = pictureOffsetFrom(anchors, Math.min(anchors.length, MONITOR_ANCHORS))
  return offset === null ? null : now / 1000 + offset
}
