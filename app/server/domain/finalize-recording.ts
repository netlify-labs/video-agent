// Finalize for a demo (screen-recording plan §5.2 check, §9; va-rsk5.3.14): before a version made from a screen
// recording becomes ready, its saved composition passes the same recording check the run did (src/lib/recording-
// check.ts), against the version's locked inputs: the frozen trace from the media store (hash checked) and the
// person's setup boxes. A lost hidden area is `redaction_removed`, anything else `recording_file_invalid`. A good one
// gets its Hidden list (every hidden area with where it's shown and who checked it) and the run's summary block.
import type { Deps } from '../deps.js'
import { sha256Hex } from '../lib/crypto.js'
import { load, read, type Summary } from '../lib/contract.js'
import { recordingCheck } from '../lib/recording-check.js'
import { parseRedactScript, LOCKED_SRC } from '../lib/recording.js'
import { parseTrace, type RedactEntry } from '../lib/recording-trace.js'
import type { HiddenArea, VersionRecording, VersionRow } from './types.js'

export type RecordingFinalize =
  | { ok: true; recording: VersionRecording }
  | { ok: false; code: 'redaction_removed' | 'recording_file_invalid'; message: string; scene: string }

const text = (files: Map<string, Uint8Array>, path: string) => {
  const b = files.get(path)
  return b ? new TextDecoder().decode(b) : null
}

export async function finalizeRecording(
  deps: Pick<Deps, 'store' | 'blobs' | 'clock' | 'log'>,
  jobId: string,
  versionN: number,
  version: Pick<VersionRow, 'recording' | 'authorId' | 'parentN' | 'editedFromN' | 'mode'>,
  files: Map<string, Uint8Array>,
): Promise<RecordingFinalize | null> {
  const r = version.recording
  if (!r) return null
  const html = text(files, 'index.html') ?? ''
  const fail = (code: 'redaction_removed' | 'recording_file_invalid', scene: string, message: string) =>
    ({
      ok: false,
      code,
      scene,
      message: `${code}: ${scene === '*' ? '' : `scene "${scene}": `}${message}`,
    }) as const

  // The locked inputs.
  let traceRedact: RedactEntry[] = []
  if (r.trace) {
    const bytes = await deps.blobs.get('media', r.trace.key)
    if (!bytes || sha256Hex(bytes) !== r.trace.sha256)
      return fail('recording_file_invalid', '*', "the pointer trace doesn't match its hash.")
    traceRedact = parseTrace(new TextDecoder().decode(bytes)).redact
  }
  const media = (await deps.store.listVersionMedia(jobId, versionN)).find((m) => m.mediaId === r.mediaId)
  const row = await deps.store.getMedia(r.mediaId)
  // Hidden areas only work inside recording scenes. With any locked ones, a composition that can't be read, or that
  // shows the recording outside a recording scene, would show it uncovered.
  const locked = traceRedact.length + r.boxes.length
  let beatsWithRecording: number
  try {
    beatsWithRecording = read(load(html)).beats.filter((b) => b.recording).length
  } catch {
    if (locked)
      return fail('redaction_removed', '*', "the saved composition can't be checked for its hidden areas.")
    return { ok: true, recording: { ...r, summary: null, hidden: [] } }
  }
  if (locked && !beatsWithRecording && html.includes(r.mediaId))
    return fail(
      'redaction_removed',
      '*',
      'the recording is shown outside a recording scene, without its hidden areas.',
    )
  const problems = recordingCheck({
    html,
    readFile: (p) => text(files, p),
    recording: media ? { filename: media.filename, durationSec: row?.durationSec ?? undefined } : null,
    locked: { trace: traceRedact, setup: r.boxes },
    // An editor render: the person set the spans, so a held end needs no voice line or retime (as in the run).
    edited: version.mode === 'render_unchanged',
  })
  const first = problems[0]
  if (first) {
    const lost = problems.find((p) => p.rule.startsWith('locked'))
    const p = lost ?? first
    return fail(lost ? 'redaction_removed' : 'recording_file_invalid', p.scene, p.message)
  }

  // The Hidden list: every hidden area, per scene it shows in, clipped to the part shown.
  const beats = read(load(html)).beats.filter((b) => b.recording)
  const lockedFile = parseRedactScript(text(files, LOCKED_SRC) ?? '')
  const lockedEntries = lockedFile.ok ? lockedFile.entries : []
  const baseN = version.editedFromN ?? version.parentN
  const base = baseN ? await deps.store.getVersion(jobId, baseN) : null
  const before = new Map((base?.recording?.hidden ?? []).map((h) => [`${h.id}@${h.beat}`, h]))
  const now = deps.clock.now().toISOString()
  const hidden: HiddenArea[] = []
  for (const b of beats) {
    const rec = b.recording
    if (!rec) continue
    const scene = rec.redact as { id: string; origin?: string; start: number; end: number; reason?: string }[]
    const all = [
      ...lockedEntries.map((e) => ({
        id: e.id,
        source: e.origin,
        start: e.start,
        end: e.end,
        reason: e.reason,
      })),
      ...scene.map((e) => ({
        id: e.id,
        source: e.origin === 'agent' ? ('agent' as const) : ('editor' as const),
        start: e.start,
        end: e.end,
        reason: e.reason ?? '',
      })),
    ]
    for (const e of all) {
      const start = Math.max(e.start, rec.in)
      const end = Math.min(e.end, rec.out)
      if (end <= start) continue
      const prior = before.get(`${e.id}@${b.id}`)
      // A box someone drew in the editor is checked by them; everything else waits for a person to check it.
      const added = e.source === 'editor' && !prior && version.mode === 'render_unchanged'
      hidden.push({
        id: e.id,
        source: e.source,
        beat: b.id,
        start,
        end,
        reason: e.reason,
        checkedBy: prior?.checkedBy ?? (added ? version.authorId : null),
        checkedAt: prior?.checkedAt ?? (added ? now : null),
      })
    }
  }

  // The run's summary block; the composition's own count of agent boxes wins.
  let summary: Summary | null
  try {
    summary = JSON.parse(text(files, 'summary.json') ?? 'null') as Summary | null
  } catch {
    summary = null
  }
  const block = (summary?.recording ?? null) as Record<string, unknown> | null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const agentBoxes = new Set(hidden.filter((h) => h.source === 'agent').map((h) => h.id)).size
  if (block && num(block.redactionsAdded) !== agentBoxes)
    deps.log.warn('finalize.recording_count_mismatch', {
      jobId,
      versionN,
      said: block.redactionsAdded,
      found: agentBoxes,
    })
  return {
    ok: true,
    recording: {
      ...r,
      summary: {
        sourceSec: row?.durationSec ?? 0,
        steps: block ? num(block.steps) || beats.length : beats.length,
        cutSec: block ? num(block.cut) : 0,
        spedUpSec: block ? num(block.spedUp) : 0,
        redactionsAdded: agentBoxes,
      },
      hidden,
    },
  }
}
