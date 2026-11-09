// `local revise --scene` (regenerate-beat plan §4.13; bead va-8cy4.5.14): the same rules, prompt and checks as the
// hosted path. The scenes come from the parent's source.tar.gz; scopeRules refuses what the server refuses; the run's
// manifest carries the scope, so prepare-run freezes the parent and render-job renders only the splice, as on the
// runner; and before copying out, the result passes finalize's check (the splice's bytes, and the MP4's length).
import { readFileSync } from 'node:fs'
import { attr, load, read } from '../../../../app/server/lib/contract.js'
import { hyperframesScopeCheck, SCOPE_REFUSED_PREFIX, scopeRules } from '../../../../app/server/lib/scope.js'
import { readTarGz } from '../../../../app/server/lib/tar.js'
import { sha256Hex } from '../../../../app/server/lib/run-manifest.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import { resolveScenes } from '../commands/scenes.js'

export type Beat = { id: string; label: string | null; start: number; duration: number }

/** finalize's SCOPE_LENGTH_SLACK_SEC: the MP4 may differ from the composition by this much. */
const LENGTH_SLACK_SEC = 0.25
/** Generous limits for a saved composition read on this machine (the archive is the person's own). */
const LIMITS = { maxEntries: 5000, maxTotalBytes: 500e6, maxFileBytes: 200e6 }

const filesOf = (path: string) => readTarGz(new Uint8Array(readFileSync(path)), LIMITS)

/** A saved composition's scenes; null when it doesn't keep the editing contract. */
export function scenesOfSource(source: string): Beat[] | null {
  const raw = filesOf(source).get('index.html')
  const html = raw ? new TextDecoder().decode(raw) : ''
  if (!/data-va-contract\s*=\s*["']1["']/.test(html)) return null
  try {
    return read(load(html)).beats.map((b) => ({
      id: b.id,
      label: b.label,
      start: b.start,
      duration: b.duration,
    }))
  } catch {
    return null
  }
}

/**
 * --scene names (ids or labels) → the scope of a local revision: the scene ids, and the scenes as the prompt lists
 * them. Unknown, ambiguous, every scene, the held frame: exit 2 with the server's words. No contract: exit 7.
 */
export function localScope(
  source: string,
  names: string[],
  n: number,
): { ids: string[]; beats: Beat[]; voiced: boolean } {
  const all = scenesOfSource(source)
  if (!all)
    throw new CliError(
      'not_editable',
      `v${n} doesn't keep the editing contract, so its scenes can't be redone one by one. Revise the whole video instead.`,
      EXIT.conflict,
    )
  const r = scopeRules(all, resolveScenes(all, names))
  if ('refusal' in r) throw new UsageError(r.refusal)
  return {
    ids: r.beats,
    beats: all.filter((b) => r.beats.includes(b.id)),
    // The prompt's voiced variant: the parent speaks its lines (assets/voice/voice.json, as the voice step writes).
    voiced: filesOf(source).has('assets/voice/voice.json'),
  }
}

/**
 * finalize's scope check, on this machine: the run's source.tar.gz must be exactly the splice of the parent and the
 * agent's scenes, and its MP4 as long as that composition. Returns the refusal, or null when it passes.
 */
export function scopeRefusal(o: {
  parentSource: string
  childSource: string
  beats: string[]
  mp4Seconds: number | null
}): string | null {
  const uploaded = filesOf(o.childSource)
  const r = hyperframesScopeCheck(filesOf(o.parentSource), uploaded, o.beats)
  const problems = [...r.problems]
  if (!problems.length && r.files)
    for (const [name, bytes] of r.files) {
      const mine = uploaded.get(name)
      if (!mine || sha256Hex(mine) !== sha256Hex(bytes))
        problems.push(
          `${name} isn't the composition the scope allows (render-job writes it; run it unchanged)`,
        )
    }
  if (problems.length || !r.files) {
    if (!problems.length) problems.push("the scenes couldn't be put together")
    const shown = problems.slice(0, 10).map((p) => p.replace(/\.$/, ''))
    return `${SCOPE_REFUSED_PREFIX}: ${shown.join('; ')}${problems.length > 10 ? ` and ${problems.length - 10} more` : ''}.`
  }
  const html = r.files.get('index.html')
  const total = html ? Number(attr(load(new TextDecoder().decode(html)).root, 'data-duration')) : NaN
  if (o.mp4Seconds === null || !(Math.abs(o.mp4Seconds - total) <= LENGTH_SLACK_SEC))
    return `The video is ${o.mp4Seconds?.toFixed(2) ?? '?'} s long but its composition is ${total.toFixed(2)} s; render the composition render-job wrote.`
  return null
}
