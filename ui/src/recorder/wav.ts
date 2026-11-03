// Mono PCM16 WAV helpers for recorded takes (from spike S10). Pure.

export function wavHeader(samples: number, sampleRate: number): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(44)
  const dv = new DataView(h.buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i)
  }
  const data = samples * 2
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + data, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  ascii(36, 'data')
  dv.setUint32(40, data, true)
  return h
}

/** Round to nearest, clamp to -32768..32767; little-endian bytes. */
export function floatToPcm16(x: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(x.length * 2)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < x.length; i++) {
    const v = Math.round((x[i] ?? 0) * 32767)
    dv.setInt16(2 * i, v > 32767 ? 32767 : v < -32768 ? -32768 : v, true)
  }
  return out
}

export function pcm16ToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength >> 1)
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(2 * i, true) / 32767
  return out
}

/** Finds the data chunk of a PCM16 mono WAV. */
export function wavData(bytes: Uint8Array): { sampleRate: number; pcm: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 12
  let sampleRate = 0
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4))
    const size = dv.getUint32(at + 4, true)
    if (id === 'fmt ') sampleRate = dv.getUint32(at + 12, true)
    if (id === 'data')
      return { sampleRate, pcm: bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size)) }
    at += 8 + size + (size & 1)
  }
  throw new Error('wav: no data chunk')
}
