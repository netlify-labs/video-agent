import { getStore } from '@netlify/blobs'
import type { BlobStoreName, BlobsPort } from '../deps.js'

const store = (name: BlobStoreName) => getStore({ name, consistency: 'strong' })

export const netlifyBlobs: BlobsPort = {
  async get(name, key) {
    const v = (await store(name).get(key, { type: 'arrayBuffer' })) as ArrayBuffer | null
    return v ? new Uint8Array(v) : null
  },
  async set(name, key, data, metadata) {
    const body =
      typeof data === 'string'
        ? data
        : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
    await store(name).set(key, body, metadata ? { metadata } : {})
  },
  async delete(name, key) {
    await store(name).delete(key)
  },
  async list(name, prefix) {
    const { blobs } = await store(name).list({ prefix })
    return blobs.map((b) => b.key)
  },
  async stream(name, key, range) {
    const s = (await store(name).get(key, { type: 'stream' })) as ReadableStream<Uint8Array> | null
    if (!s || !range) return s
    return sliceStream(s, range.start, range.end)
  },
}

/** Bytes [start, end] (inclusive) of a stream, discarding what comes before (the SDK has no ranged read). */
export function sliceStream(
  s: ReadableStream<Uint8Array>,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let pos = 0
  const reader = s.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || pos > end) {
          ctl.close()
          void reader.cancel().catch(() => undefined)
          return
        }
        const from = Math.max(0, start - pos)
        const to = Math.min(value.byteLength, end - pos + 1)
        pos += value.byteLength
        if (to > from) {
          ctl.enqueue(value.subarray(from, to))
          return
        }
      }
    },
    cancel: () => reader.cancel(),
  })
}
