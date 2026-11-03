// A streaming SHA-256 (FIPS 180-4), from spike S10. SubtleCrypto.digest() only takes the whole message, so the recorder
// worker hashes the PCM as it is produced with this instead and never holds the take in memory. clone() copies the
// state, so a running digest can be read (for the recovery record) without disturbing the stream. Pure: no DOM, no
// Node built-ins; checked against node:crypto in recorder.test.ts.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

export class Sha256 {
  private h = Uint32Array.from(H0)
  private buf = new Uint8Array(64)
  private bufLen = 0
  private bytes = 0
  private readonly w = new Uint32Array(64)

  update(data: Uint8Array): this {
    let i = 0
    this.bytes += data.length
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length)
      this.buf.set(data.subarray(0, take), this.bufLen)
      this.bufLen += take
      i = take
      if (this.bufLen < 64) return this
      this.block(this.buf, 0)
      this.bufLen = 0
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i)
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0)
      this.bufLen = data.length - i
    }
    return this
  }

  clone(): Sha256 {
    const c = new Sha256()
    c.h = this.h.slice()
    c.buf = this.buf.slice()
    c.bufLen = this.bufLen
    c.bytes = this.bytes
    return c
  }

  digest(): Uint8Array {
    const bits = this.bytes * 8
    const pad = new Uint8Array(((this.bufLen + 9 + 63) & ~63) - this.bufLen)
    pad[0] = 0x80
    const dv = new DataView(pad.buffer)
    dv.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32))
    dv.setUint32(pad.length - 4, bits >>> 0)
    const total = this.bytes
    this.update(pad)
    this.bytes = total
    const out = new Uint8Array(32)
    const odv = new DataView(out.buffer)
    for (let j = 0; j < 8; j++) odv.setUint32(4 * j, this.h[j] ?? 0)
    return out
  }

  hex(): string {
    return toHex(this.digest())
  }

  private block(d: Uint8Array, at: number): void {
    const w = this.w
    for (let t = 0; t < 16; t++) {
      const o = at + 4 * t
      w[t] = (((d[o] ?? 0) << 24) | ((d[o + 1] ?? 0) << 16) | ((d[o + 2] ?? 0) << 8) | (d[o + 3] ?? 0)) >>> 0
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15] ?? 0
      const y = w[t - 2] ?? 0
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[t] = ((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) >>> 0
    }
    const h = this.h
    let a = h[0] ?? 0
    let b = h[1] ?? 0
    let c = h[2] ?? 0
    let e4 = h[3] ?? 0
    let e = h[4] ?? 0
    let f = h[5] ?? 0
    let g = h[6] ?? 0
    let hh = h[7] ?? 0
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + (K[t] ?? 0) + (w[t] ?? 0)) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (e4 + t1) >>> 0
      e4 = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0
    h[1] = ((h[1] ?? 0) + b) >>> 0
    h[2] = ((h[2] ?? 0) + c) >>> 0
    h[3] = ((h[3] ?? 0) + e4) >>> 0
    h[4] = ((h[4] ?? 0) + e) >>> 0
    h[5] = ((h[5] ?? 0) + f) >>> 0
    h[6] = ((h[6] ?? 0) + g) >>> 0
    h[7] = ((h[7] ?? 0) + hh) >>> 0
  }
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
