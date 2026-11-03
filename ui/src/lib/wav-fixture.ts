// Test fixture: a PCM16 WAV built in memory, for the audition's decode and engine tests.
import { SAMPLE_RATE } from '../../../src/lib/timeline'

/** A PCM WAV with an extra chunk before data (and an odd-sized one, to exercise word alignment). */
export function wav(
  samples: readonly number[][],
  { rate = SAMPLE_RATE, extensible = false }: { rate?: number; extensible?: boolean } = {},
): ArrayBuffer {
  const channels = samples.length
  const frames = samples[0]?.length ?? 0
  const fmtSize = extensible ? 40 : 16
  const extra = 3 // "LIST" chunk with an odd body: padded to 4
  const size = 12 + 8 + fmtSize + 8 + extra + 1 + 8 + frames * channels * 2
  const v = new DataView(new ArrayBuffer(size))
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  tag(0, 'RIFF')
  v.setUint32(4, size - 8, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, fmtSize, true)
  v.setUint16(20, extensible ? 0xfffe : 1, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * channels * 2, true)
  v.setUint16(32, channels * 2, true)
  v.setUint16(34, 16, true)
  let at = 36
  if (extensible) {
    v.setUint16(36, 22, true)
    v.setUint16(44, 1, true) // sub-format GUID starts with PCM = 1
    at = 20 + 40
  }
  tag(at, 'LIST')
  v.setUint32(at + 4, extra, true)
  at += 8 + extra + 1
  tag(at, 'data')
  v.setUint32(at + 4, frames * channels * 2, true)
  at += 8
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < channels; c++) {
      v.setInt16(at, samples[c]?.[f] ?? 0, true)
      at += 2
    }
  return v.buffer
}
