// Re-voicing a line from the browser editor (render-unchanged runs). The draft records the new line in
// assets/voice/script.json and marks the beat's clip data-va-revoice; the run re-speaks exactly the marked beats with
// scripts/voice.ts revoice. Only the files that step writes may change: render-job checks every other file against
// the frozen bundle (keptHash), and recomputes index.html and summary.json from the frozen ones and the new voice.json.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bundleManifest, excluded, manifestHash } from './bundle-manifest.js'
import { isReference } from './bundle-references.js'
import { applyRevoice, load, normalizeLine, read, type RevoicedLine, type Summary } from './contract.js'
import {
  FPS_TOLERANCE,
  SAMPLE_RATE,
  VOICE_DIR,
  VOICE_JSON,
  minBeatSeconds,
  type VoiceFile,
  type VoiceScript,
} from './voice.js'

/** Where prepare-run keeps the frozen files render-job recomputes from (outside video/, so never rendered). */
export const FROZEN_DIR = '.render/frozen'
export const FROZEN_FILES = ['index.html', 'summary.json', VOICE_JSON] as const

/** Files a re-voicing run may change: the composition, its captions, voice.json and the marked beats' audio. */
export function revoicable(path: string, beats: readonly string[]): boolean {
  if ((FROZEN_FILES as readonly string[]).includes(path)) return true
  return beats.some((b) => path === `${VOICE_DIR}/${b}.wav`)
}

/**
 * The canonical manifest hash over the files a re-voicing run must leave alone. Reference files (the narration bus)
 * never count: a frozen bundle doesn't hold one, and a narration step writes its own (checkNarration checks it).
 */
export function keptHash(files: { path: string; sha256: string }[], beats: readonly string[]): string {
  return manifestHash(
    files.filter((f) => !excluded(f.path) && !isReference(f.path) && !revoicable(f.path, beats)),
    [],
  )
}

/** What applyRevoice needs for each re-spoken beat, from the composition (the voice's lead) and the new voice.json. */
export function revoiceLines(
  html: string,
  voice: Pick<VoiceFile, 'beats'>,
  beats: readonly string[],
): RevoicedLine[] {
  const comp = read(load(html))
  return beats.map((id) => {
    const lead = comp.beats.find((b) => b.id === id)?.voice?.start
    const v = voice.beats.find((x) => x.beat === id)
    if (lead === undefined || !v) throw new Error(`Beat "${id}" has no voice to re-voice.`)
    return {
      beat: id,
      file: v.file,
      duration: v.duration,
      minBeat: minBeatSeconds(lead, v.duration),
      cues: v.cues.map((c) => ({
        text: c.text,
        start: Math.round((lead + c.start) * 1000) / 1000,
        end: Math.round((lead + c.end) * 1000) / 1000,
      })),
    }
  })
}

const json = (s: string) => JSON.parse(s) as unknown
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Checks a re-voiced video/ against the frozen bundle: the kept files are untouched, voice.json changed only for the
 * marked beats (same provider, voice and speed; each new entry says its script line), every re-spoken file has the
 * length voice.json says, and index.html and summary.json are exactly what applyRevoice makes of the frozen ones.
 * Returns the problems.
 */
export function checkRevoiced(
  videoDir: string,
  frozenDir: string,
  expected: { beats: readonly string[]; keptHash: string },
): string[] {
  const { problems, want } = expectRevoiced(videoDir, frozenDir, expected)
  if (!want) return problems
  const file = (p: string) => {
    const full = join(videoDir, p)
    return existsSync(full) ? readFileSync(full, 'utf8') : null
  }
  if (file('index.html') !== want.html)
    problems.push('index.html differs from the frozen composition with the re-voiced lines.')
  if (!same(json(file('summary.json') ?? '{}'), want.summary))
    problems.push('summary.json differs from the frozen captions with the re-voiced lines.')
  return problems
}

/**
 * Everything checkRevoiced checks except the last comparison, plus what index.html and summary.json should be after
 * re-voicing (`want`, when nothing else is wrong). A narrated run (checkNarration) writes the narration over `want`.
 */
export function expectRevoiced(
  videoDir: string,
  frozenDir: string,
  expected: { beats: readonly string[]; keptHash: string },
): { problems: string[]; want?: { html: string; summary: Summary } } {
  const { beats } = expected
  const problems: string[] = []
  if (keptHash(bundleManifest(videoDir).files, beats) !== expected.keptHash)
    problems.push('Files other than the re-voiced lines changed since prepare-run restored video/.')
  const file = (dir: string, p: string) => {
    const full = join(dir, p)
    return existsSync(full) ? readFileSync(full, 'utf8') : null
  }
  const frozen = Object.fromEntries(FROZEN_FILES.map((p) => [p, file(frozenDir, p)]))
  if (FROZEN_FILES.some((p) => frozen[p] === null))
    return { problems: [...problems, `The frozen copies prepare-run keeps in ${FROZEN_DIR} are missing.`] }
  let voice: VoiceFile
  let was: VoiceFile
  let script: VoiceScript
  try {
    voice = json(file(videoDir, VOICE_JSON) ?? '') as VoiceFile
    was = json(frozen[VOICE_JSON] ?? '') as VoiceFile
    script = json(file(videoDir, `${VOICE_DIR}/script.json`) ?? '') as VoiceScript
  } catch {
    return { problems: [...problems, `${VOICE_JSON} or ${VOICE_DIR}/script.json can't be read.`] }
  }
  if (voice.provider !== was.provider || voice.voice !== was.voice || voice.speed !== was.speed)
    problems.push('The re-voiced lines must use the video’s voice, provider and speed.')
  const ids = (v: VoiceFile) =>
    v.beats
      .map((b) => b.beat)
      .sort()
      .join()
  if (ids(voice) !== ids(was)) problems.push(`${VOICE_JSON} gained or lost a beat.`)
  for (const b of voice.beats) {
    const old = was.beats.find((x) => x.beat === b.beat)
    if (!beats.includes(b.beat)) {
      if (!same(b, old))
        problems.push(`Beat "${b.beat}" wasn't marked for re-voicing, but its voice changed.`)
      continue
    }
    const line = script.lines.find((l) => l.beat === b.beat)
    if (!line || normalizeLine(line.text) !== b.text)
      problems.push(`Beat "${b.beat}"'s new voice doesn't say its line in script.json.`)
    const wav = join(videoDir, b.file)
    const seconds = existsSync(wav) ? (statSync(wav).size - 44) / 2 / SAMPLE_RATE : NaN
    if (!(Math.abs(seconds - b.duration) <= FPS_TOLERANCE))
      problems.push(`${b.file} isn't the ${b.duration}s voice.json says.`)
  }
  if (problems.length) return { problems }
  try {
    const want = applyRevoice(
      frozen['index.html'] ?? '',
      json(frozen['summary.json'] ?? '{}') as Summary,
      revoiceLines(frozen['index.html'] ?? '', voice, beats),
    )
    return { problems, want: { html: want.html, summary: want.summary } }
  } catch (e) {
    return { problems: [e instanceof Error ? e.message : String(e)] }
  }
}
