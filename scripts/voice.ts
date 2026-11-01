// Voice-over for a run (SPIKES.md S9). Two steps, both run from the repo root:
//   npx tsx scripts/voice.ts [--voice <id>] [--speed <0.7-1.3>]
//     Reads video/assets/voice/script.json ({ "lines": [{ "beat", "text" }] }), speaks each line and writes
//     video/assets/voice/<beat>.wav plus voice.json (cues and word times per beat). A beat whose line, voice and speed
//     are unchanged keeps its audio, so revisions only re-speak what changed. Prints each beat's voice length and the
//     shortest the beat can be.
//   npx tsx scripts/voice.ts sync
//     After video/index.html places the voices: checks each <audio data-va-voice> against voice.json, writes the
//     narration captions into video/summary.json and the music's ducking lane into index.html.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyDucking, load, read, save, type Summary } from '../src/lib/contract.js'
import {
  DEFAULT_LEAD,
  FPS_TOLERANCE,
  SAMPLE_RATE,
  SPEED_RANGE,
  VOICE_DIR,
  VOICE_ID,
  VOICE_JSON,
  VOICE_SCRIPT,
  joinPcm,
  layoutBeat,
  lineHash,
  minBeatSeconds,
  parseScript,
  splitPhrases,
  voiceCaptions,
  type BeatVoice,
  type Speech,
  type VoiceFile,
  type VoiceProvider,
  type VoiceScript,
} from '../src/lib/voice.js'
import { pickProvider, toPcm as ffmpegPcm } from './lib/voice-providers.js'
import { StepError, log, parseArgs, repoRoot } from './lib/run-tools.js'

/** Speaks every line of the script into `videoDir`; `provider` and `toPcm` are injectable for tests. */
export async function generateVoice(
  videoDir: string,
  script: VoiceScript,
  opts: { provider: VoiceProvider; voice: string; speed: number; toPcm?: (s: Speech) => Uint8Array },
): Promise<VoiceFile> {
  const toPcm = opts.toPcm ?? ffmpegPcm
  const dir = join(videoDir, VOICE_DIR)
  mkdirSync(dir, { recursive: true })
  const previous = readVoice(videoDir)
  const beats: BeatVoice[] = []
  for (const line of script.lines) {
    const text = line.text.replace(/\s+/g, ' ').trim()
    const hash = lineHash(opts.provider.name, opts.voice, opts.speed, text)
    const file = `${VOICE_DIR}/${line.beat}.wav`
    const old = previous?.beats.find((b) => b.beat === line.beat)
    if (old?.hash === hash && old.file === file && existsSync(join(videoDir, file))) {
      beats.push(old)
      log('voice.reused', { beat: line.beat })
      continue
    }
    const started = Date.now()
    const clips: { text: string; seconds: number; words?: Speech['words']; pcm: Uint8Array }[] = []
    for (const phrase of splitPhrases(text)) {
      const speech = await opts.provider.synthesize(phrase, { voice: opts.voice, speed: opts.speed })
      const pcm = toPcm(speech)
      clips.push({ text: phrase, seconds: pcm.length / 2 / SAMPLE_RATE, words: speech.words, pcm })
    }
    const laid = layoutBeat(clips)
    writeFileSync(
      join(videoDir, file),
      joinPcm(
        clips.map((c) => c.pcm),
        laid.placements,
        laid.totalSamples,
      ),
    )
    beats.push({
      beat: line.beat,
      text,
      hash,
      file,
      duration: laid.duration,
      cues: laid.cues,
      words: laid.words,
      estimated: laid.estimated,
    })
    log('voice.spoken', {
      beat: line.beat,
      seconds: laid.duration,
      phrases: clips.length,
      ms: Date.now() - started,
    })
  }
  const voice: VoiceFile = { v: 1, provider: opts.provider.name, voice: opts.voice, speed: opts.speed, beats }
  writeFileSync(join(videoDir, VOICE_JSON), JSON.stringify(voice, null, 2))
  return voice
}

export function readVoice(videoDir: string): VoiceFile | null {
  const p = join(videoDir, VOICE_JSON)
  if (!existsSync(p)) return null
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as { v?: unknown; beats?: unknown }
    return v.v === 1 && Array.isArray(v.beats) ? (v as VoiceFile) : null
  } catch {
    return null
  }
}

/**
 * Checks the composition's voices against voice.json, then writes the narration captions (replacing the captions of
 * voiced beats) and the ducking lane. Returns the problems; nothing is written when there are any.
 */
export function syncVoice(videoDir: string): string[] {
  const voice = readVoice(videoDir)
  if (!voice) return [`${VOICE_JSON} is missing. Run npx tsx scripts/voice.ts first.`]
  const htmlPath = join(videoDir, 'index.html')
  const d = load(readFileSync(htmlPath, 'utf8'))
  const comp = read(d)
  const problems: string[] = []
  for (const v of voice.beats) {
    const b = comp.beats.find((x) => x.id === v.beat)
    if (!b) {
      problems.push(`voice.json has a line for beat "${v.beat}", but index.html has no such beat.`)
      continue
    }
    if (!b.voice) {
      problems.push(
        `Beat "${v.beat}" has narration but no <audio data-va-voice="${v.beat}" src="${v.file}"> inside it.`,
      )
      continue
    }
    if (b.voice.src !== v.file) problems.push(`Beat "${v.beat}"'s voice must use src="${v.file}".`)
    if (Math.abs(b.voice.duration - v.duration) > FPS_TOLERANCE)
      problems.push(`Beat "${v.beat}"'s voice needs data-duration="${v.duration}" (the length of ${v.file}).`)
    if (b.voice.start + v.duration > b.duration + FPS_TOLERANCE)
      problems.push(
        `Beat "${v.beat}" is ${b.duration}s; with its voice starting at ${b.voice.start}s it needs at least ${minBeatSeconds(b.voice.start, v.duration)}s.`,
      )
  }
  for (const b of comp.beats)
    if (b.voice && !voice.beats.some((v) => v.beat === b.id))
      problems.push(`Beat "${b.id}" has a voice but no line in voice.json.`)
  if (problems.length) return problems

  const summaryPath = join(videoDir, 'summary.json')
  let summary: Summary = {}
  if (existsSync(summaryPath)) {
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Summary
    } catch {
      return ['video/summary.json is not valid JSON.']
    }
  }
  const voiced = new Set(voice.beats.map((v) => v.beat))
  const kept = (summary.captions ?? []).filter((c) => !c.voice && !(c.beat && voiced.has(c.beat)))
  const captions = [...kept, ...voiceCaptions(comp.beats, voice)].sort((a, b) => a.start - b.start)
  writeFileSync(summaryPath, JSON.stringify({ ...summary, captions }, null, 2))
  const before = save(d)
  applyDucking(d)
  const after = save(d)
  if (after !== before) writeFileSync(htmlPath, after)
  log('voice.synced', { captions: captions.length, ducked: after !== before })
  return []
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const videoDir = join(repoRoot, 'video')
  if (process.argv[2] === 'sync') {
    const problems = syncVoice(videoDir)
    if (problems.length) {
      for (const p of problems) console.log(`- ${p}`)
      process.exit(1)
    }
    console.log('Voice synced: narration captions are in summary.json and the music ducks under the voice.')
    return
  }
  const scriptPath = join(videoDir, VOICE_SCRIPT)
  if (!existsSync(scriptPath))
    throw new StepError(
      `Write ${VOICE_SCRIPT} in video/ first: { "lines": [{ "beat": "intro", "text": "…" }] }.`,
    )
  let script: VoiceScript
  try {
    script = parseScript(readFileSync(scriptPath, 'utf8'))
  } catch (e) {
    throw new StepError(`video/${VOICE_SCRIPT}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const speed = Number(args.speed ?? script.speed ?? 1)
  if (!(speed >= SPEED_RANGE[0] && speed <= SPEED_RANGE[1]))
    throw new StepError(`--speed must be between ${SPEED_RANGE[0]} and ${SPEED_RANGE[1]}.`)
  const voiceId = args.voice ?? script.voice
  if (voiceId !== undefined && !VOICE_ID.test(voiceId)) throw new StepError('--voice must be a voice id.')
  const picked = pickProvider(voiceId, process.env, videoDir)
  const voice = await generateVoice(videoDir, script, {
    provider: picked.provider,
    voice: picked.voice,
    speed,
  })
  console.log(`Voice-over (${voice.provider}, ${voice.voice}, speed ${voice.speed}):`)
  for (const b of voice.beats)
    console.log(
      `- ${b.beat}: ${b.duration}s of speech in ${b.file}. With the voice at data-start="${DEFAULT_LEAD}", the beat needs at least ${minBeatSeconds(DEFAULT_LEAD, b.duration)}s. <audio id="voice-${b.beat}" data-va-voice="${b.beat}" src="${b.file}" data-start="${DEFAULT_LEAD}" data-duration="${b.duration}" data-track-index="3" data-volume="1"></audio>`,
    )
  console.log(
    `Cues and word times are in video/${VOICE_JSON}. After writing index.html, run: npx tsx scripts/voice.ts sync`,
  )
}

if (process.argv[1]?.endsWith('voice.ts'))
  main().catch((e: unknown) => {
    console.error(`voice failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
