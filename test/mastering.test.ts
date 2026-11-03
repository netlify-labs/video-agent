// Mastering narrated renders (plan 2026-11-02 §6.3 step 7, bead va-2qq.3.11) on MP4s made here with ffmpeg: a loud,
// a quiet, a silent and a peak-limited mix; the video packets stay byte-identical through the audio re-encode. Plus
// the automation cap render-job enforces before rendering. The ffmpeg cases skip without ffmpeg.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MASTER,
  MAX_AUTOMATION_POINTS,
  automationOverCap,
  master,
  measure,
  narrationOf,
  planGain,
  videoPackets,
} from '../scripts/lib/mastering.js'
import { which } from '../scripts/lib/run-tools.js'

const ffmpeg = which('ffmpeg')
const dir = mkdtempSync(join(tmpdir(), 'va-master-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A 4 s 160x90 H.264 + AAC MP4 with `audio` (an ffmpeg lavfi source) as its sound. */
function mp4(name: string, audio: string): string {
  const out = join(dir, `${name}.mp4`)
  const r = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x90:rate=30:duration=4',
      '-f',
      'lavfi',
      '-i',
      audio,
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      out,
    ],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(r.stderr)
  return out
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const inWindow = (lufs: number | null) =>
  lufs !== null && Math.abs(lufs - MASTER.targetLufs) <= MASTER.toleranceLu

describe('planGain', () => {
  it('exempts silent and speechless mixes, leaves an in-target one, and caps the gain at the peak', () => {
    expect(planGain({ integratedLufs: null, truePeakDb: -120 }, { speech: true })).toMatchObject({
      status: 'exempt',
      warnings: ['silent'],
    })
    expect(planGain({ integratedLufs: -55, truePeakDb: -40 }, { speech: true }).status).toBe('exempt')
    expect(planGain({ integratedLufs: -20, truePeakDb: -8 }, { speech: false })).toMatchObject({
      status: 'exempt',
      warnings: ['no_speech'],
    })
    expect(planGain({ integratedLufs: -14.6, truePeakDb: -3 }, { speech: true }).status).toBe('within_target')
    expect(planGain({ integratedLufs: -21, truePeakDb: -9 }, { speech: true })).toEqual({
      status: 'mastered',
      gainDb: 7,
      warnings: [],
    })
    // Peak first: -30 LUFS with a -2 dBTP peak only gets +0.8 dB, and says so.
    const limited = planGain({ integratedLufs: -30, truePeakDb: -2 }, { speech: true })
    expect(limited.gainDb).toBe(0.8)
    expect(limited.warnings[0]).toMatch(/^peak_limited: -29.2 LUFS/)
    // In the window but over the ceiling: turned down to the peak.
    expect(planGain({ integratedLufs: -13.5, truePeakDb: -0.4 }, { speech: true }).gainDb).toBe(-0.8)
  })
})

describe('the automation cap and narration detection', () => {
  const lane = (n: number) =>
    JSON.stringify({
      version: 1,
      lanes: [{ target: 'volume', points: Array.from({ length: n }, (_, i) => ({ t: i / 10, v: 1 })) }],
    }).replace(/"/g, '&quot;')
  it(`refuses a lane over ${MAX_AUTOMATION_POINTS} points anywhere in the document, and allows ${MAX_AUTOMATION_POINTS}`, () => {
    const html = (n: number) =>
      `<div id="root"><section><audio id="music" data-automation="${lane(n)}"></audio></section></div>`
    expect(automationOverCap(html(MAX_AUTOMATION_POINTS))).toEqual([])
    expect(automationOverCap(html(MAX_AUTOMATION_POINTS + 1))).toEqual([
      { element: 'music', target: 'volume', points: MAX_AUTOMATION_POINTS + 1 },
    ])
    expect(automationOverCap(html(MAX_AUTOMATION_POINTS + 1), 512)).toEqual([])
    expect(automationOverCap(html(513), 512)).toHaveLength(1)
    expect(automationOverCap('<div data-automation="not json"></div>')).toEqual([])
  })
  it('finds the narration bus and whether it has speech', () => {
    expect(narrationOf('<div id="root"><audio id="music"></audio></div>')).toEqual({
      narrated: false,
      speech: false,
    })
    expect(narrationOf('<div id="root"><audio id="va-narration" data-va-speech="[]"></audio></div>')).toEqual(
      {
        narrated: true,
        speech: false,
      },
    )
    expect(
      narrationOf('<div id="root"><audio id="va-narration" data-va-speech="[[0.5,2]]"></audio></div>'),
    ).toEqual({ narrated: true, speech: true })
  })
})

describe.skipIf(!ffmpeg)('master (ffmpeg)', () => {
  it('turns a loud mix down into the window; the video packets are byte-identical', () => {
    const v = mp4('loud', 'sine=frequency=440:sample_rate=48000,volume=14dB')
    const packets = videoPackets(v)
    const before = measure(v)
    expect(before.integratedLufs).toBeGreaterThan(-12)
    const r = master(v, { speech: true })
    expect(r.status).toBe('mastered')
    expect(r.gainDb).toBeLessThan(0)
    expect(inWindow(r.after?.integratedLufs ?? null)).toBe(true)
    expect(r.after?.truePeakDb).toBeLessThanOrEqual(MASTER.ceilingDbtp)
    expect(r.warnings).toEqual([])
    expect(videoPackets(v)).toEqual(packets)
  })

  it('brings a quiet mix up into the window, under the ceiling', () => {
    const v = mp4('quiet', 'sine=frequency=440:sample_rate=48000,volume=-20dB')
    const packets = videoPackets(v)
    const r = master(v, { speech: true })
    expect(r.before.integratedLufs).toBeLessThan(-30)
    expect(r.gainDb).toBeGreaterThan(15)
    expect(inWindow(r.after?.integratedLufs ?? null)).toBe(true)
    expect(r.after?.truePeakDb).toBeLessThanOrEqual(MASTER.ceilingDbtp)
    expect(videoPackets(v)).toEqual(packets)
  })

  it('leaves a silent mix and a speechless narration alone (the file is untouched)', () => {
    const v = mp4('silent', 'anullsrc=r=48000:cl=stereo')
    const was = sha(v)
    expect(master(v, { speech: true })).toMatchObject({
      status: 'exempt',
      after: null,
      gainDb: 0,
      warnings: ['silent'],
    })
    expect(sha(v)).toBe(was)
    const q = mp4('speechless', 'sine=frequency=440:sample_rate=48000,volume=-20dB')
    const qWas = sha(q)
    expect(master(q, { speech: false })).toMatchObject({ status: 'exempt', warnings: ['no_speech'] })
    expect(sha(q)).toBe(qWas)
  })

  it("keeps the peak when a peaky mix can't reach the target, and records the measured LUFS with a warning", () => {
    // A quiet bed with short, near-full-scale bursts: loudness far under -14, peak near 0 dBFS.
    const v = mp4(
      'peaky',
      "aevalsrc='0.01*sin(2*PI*440*t)+if(lt(mod(t\\,1)\\,0.004)\\,0.95*sin(2*PI*2000*t)\\,0)':s=48000:c=stereo",
    )
    const packets = videoPackets(v)
    const r = master(v, { speech: true })
    expect(r.status).toBe('mastered')
    expect(r.after?.truePeakDb).toBeLessThanOrEqual(MASTER.ceilingDbtp)
    expect(r.after?.integratedLufs ?? 0).toBeLessThan(MASTER.targetLufs - MASTER.toleranceLu)
    expect(r.warnings[0]).toMatch(/^peak_limited/)
    expect(videoPackets(v)).toEqual(packets)
  })
})
