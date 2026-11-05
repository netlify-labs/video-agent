// The timeline's props and the events it emits (docs/plans/2026-11-02-record-your-own-voiceover.md §2.3, §5.5).
// Everything is controlled: the editor owns the narration op, the playhead and the selection; the timeline owns only
// its zoom and scroll. Narration positions are composition samples; the composition's beats and audio come in its
// own seconds, as read() gives them.
import type { AudioTrack, Beat } from '../../../../src/lib/contract'
import type { Peaks } from '../../../../src/lib/peaks'
import type { NarrationOp, NarrationTracks, Span } from '../../../../src/lib/timeline'

export type LaneId = 'scenes' | 'narration' | 'aiVoice' | 'music'

/** The parts of the composition the lanes show. */
export interface TimelineComposition {
  /** Seconds. */
  duration: number
  beats: readonly Pick<Beat, 'id' | 'label' | 'start' | 'duration' | 'voice'>[]
  audio: readonly Pick<AudioTrack, 'id' | 'role' | 'label' | 'volume' | 'muted'>[]
}

/** A change to one lane's controls. The narration lanes patch the op's tracks; music's level is the composition's. */
export type TrackPatch =
  | { lane: 'narration'; set: Partial<NarrationTracks['narration']> }
  | { lane: 'aiVoice'; set: Partial<NarrationTracks['aiVoice']> }
  | { lane: 'music'; set: Partial<NarrationTracks['music']> }
  /** The composition's music layer level (an `audio` edit op), 0-1. */
  | { lane: 'musicLevel'; audioId: string; set: { volume?: number; muted?: boolean } }

export type ClipPart = 'body' | 'start' | 'end'

/**
 * What a clip's pointer and key events delegate to the editor (the editing commands, va-2qq.5.2, turn them into
 * moves, trims, splits and deletes). `sample` is the composition sample under the pointer; `pxPerSec` the zoom, for
 * snapping (ui/src/lib/timeline-snap.ts). The timeline itself only selects on pointer down.
 */
export type ClipCommand =
  | {
      type: 'pointer'
      phase: 'down' | 'move' | 'up' | 'cancel'
      clipId: string
      part: ClipPart
      sample: number
      pxPerSec: number
      pointerId: number
      altKey: boolean
      shiftKey: boolean
    }
  | {
      type: 'key'
      clipId: string
      key: string
      altKey: boolean
      shiftKey: boolean
      metaKey: boolean
      ctrlKey: boolean
      /** Call when the editor acted on the key; the timeline then prevents the browser's default for it. */
      handled: () => void
    }
  /** A right-click (or long press) on a clip: open its menu at this viewport position. */
  | { type: 'menu'; clipId: string; clientX: number; clientY: number }

export interface TimelineProps {
  op: NarrationOp
  composition: TimelineComposition
  /** Decoded peaks (decodePeaks of each take's peaks.bin) by media id; a clip without them draws as a plain block. */
  peaks: ReadonlyMap<string, Peaks>
  /** Peaks for AI voice clips, by voice clip id (optional). */
  voicePeaks?: ReadonlyMap<string, Peaks>
  /** Each take's speech spans in source samples, for the music lane's duck marks. */
  takeSpans?: ReadonlyMap<string, readonly Span[]>
  /** A display name per take (its media title), for clip labels. */
  takeNames?: ReadonlyMap<string, string>
  /** Composition sample under the playhead. */
  playhead: number
  selectedClipId: string | null
  /** The selected range in composition samples (for punch-in), or null. */
  range: Span | null
  onSeek: (sample: number) => void
  onTrackChange: (patch: TrackPatch) => void
  onSelectClip: (clipId: string | null) => void
  onRangeSelect: (range: Span | null) => void
  onClipCommand?: (command: ClipCommand) => void
  /**
   * Audio files dropped on the Narration lane, with the composition sample they land at (snapped like a dragged
   * edge; Alt / Option turns it off). Without it the lane takes no drops.
   */
  onDropFiles?: (files: File[], sample: number) => void
  /** A menu on each scene block whose scene it offers (redo a scene: Redo this scene…). */
  sceneMenu?: { label: string; offers: (beatId: string) => boolean; onPick: (beatId: string) => void }
  /** Initial zoom in px per second; the timeline fits the composition when it's left out. */
  initialPxPerSec?: number
  /** Called with the zoom whenever it changes. */
  onZoomChange?: (pxPerSec: number) => void
}
