// `engine.ts mix` on Remotion (render-engines plan §5.6, Phase 2): sets the music layer's level from the source file's
// measured loudness, so the bed lands near -14 LUFS with its true peak at or under -1 dBTP. No render, so nothing is
// counted; only audio.music.volume in props.json changes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_VOLUME } from '../../../app/server/lib/contract.js'
import { MASTER, measure } from '../mastering.js'
import { run } from '../run-tools.js'

const r3 = (n: number) => Math.round(n * 1000) / 1000

export interface MixReport {
  lufsSrc: number | null
  truePeakSrc: number
  volume: number
  truePeakAtGain: number
  clamped: boolean
}

/** The level for a track measured at this loudness and true peak: toward the target, then under the ceiling. */
export function musicVolume(
  lufsSrc: number | null,
  truePeakSrc: number,
): Omit<MixReport, 'lufsSrc' | 'truePeakSrc'> {
  // A silent or unmeasurable track keeps unity gain: there's nothing to bring up.
  let volume =
    lufsSrc === null || lufsSrc < MASTER.silentLufs ? 1 : 10 ** ((MASTER.targetLufs - lufsSrc) / 20)
  let clamped = false
  if (volume > MAX_VOLUME) {
    volume = MAX_VOLUME
    clamped = true
  }
  const peakAt = (v: number) => truePeakSrc + 20 * Math.log10(v)
  if (peakAt(volume) > MASTER.ceilingDbtp) volume = 10 ** ((MASTER.ceilingDbtp - truePeakSrc) / 20)
  return { volume: r3(volume), truePeakAtGain: Math.round(peakAt(volume) * 100) / 100, clamped }
}

export function mixMusic(
  videoDir: string,
  o: { ffmpeg?: string; log?: (step: string, fields?: Record<string, unknown>) => void } = {},
): MixReport | null {
  const log = o.log ?? (() => {})
  const path = join(videoDir, 'props.json')
  const props = JSON.parse(readFileSync(path, 'utf8')) as {
    beats: { duration: number }[]
    audio: { music: { src: string; volume: number } | null }
  }
  const music = props.audio.music
  if (!music) {
    log('engine.mix', { skipped: 'no music' })
    return null
  }
  // Only the part the video plays: the first `duration` seconds.
  const duration = props.beats.reduce((s, b) => s + b.duration, 0)
  const dir = mkdtempSync(join(tmpdir(), 'va-mix-'))
  try {
    const clip = join(dir, 'music.wav')
    run(o.ffmpeg ?? 'ffmpeg', [
      '-v',
      'error',
      '-y',
      '-t',
      String(duration),
      '-i',
      join(videoDir, music.src),
      clip,
    ])
    const m = measure(clip, o.ffmpeg)
    const report = {
      lufsSrc: m.integratedLufs,
      truePeakSrc: m.truePeakDb,
      ...musicVolume(m.integratedLufs, m.truePeakDb),
    }
    music.volume = report.volume
    writeFileSync(path, `${JSON.stringify(props, null, 2)}\n`)
    log('engine.mix', { ...report })
    return report
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
