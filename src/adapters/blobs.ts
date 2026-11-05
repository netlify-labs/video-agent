import { getStore } from '@netlify/blobs'
import type { BlobStoreName, BlobsPort } from '../deps.js'

const store = (name: BlobStoreName) => getStore({ name, consistency: 'strong' })

/** Bodies above this go out as a stream of views: fetch copies a buffered body whole (spike D5), a stream it doesn't. */
export const STREAM_ABOVE = 8 * 1024 * 1024
const STREAM_CHUNK = 1024 * 1024
const STREAM_ATTEMPTS = 3

/** The bytes as a stream of 1 MB views (no copy). A stream is read once, so each attempt makes a new one. */
export function viewStream(data: Uint8Array): ReadableStream<Uint8Array> {
  let off = 0
  return new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (off >= data.byteLength) return ctl.close()
      ctl.enqueue(data.subarray(off, Math.min(data.byteLength, off + STREAM_CHUNK)))
      off += STREAM_CHUNK
    },
  })
}

export const netlifyBlobs: BlobsPort = {
  async get(name, key) {
    const v = (await store(name).get(key, { type: 'arrayBuffer' })) as ArrayBuffer | null
    return v ? new Uint8Array(v) : null
  },
  async set(name, key, data, metadata) {
    const opts = metadata ? { metadata } : {}
    if (typeof data !== 'string' && data.byteLength > STREAM_ABOVE) {
      // The SDK passes a ReadableStream body to fetch (duplex: 'half') though its types don't list it. Its own retry
      // would resend the spent stream, so retries happen here with a fresh one.
      for (let attempt = 1; ; attempt++) {
        try {
          await store(name).set(key, viewStream(data) as unknown as Blob, opts)
          return
        } catch (e) {
          if (attempt >= STREAM_ATTEMPTS) throw e
          await new Promise((r) => setTimeout(r, 500 * attempt))
        }
      }
    }
    const body =
      typeof data === 'string'
        ? data
        : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
    await store(name).set(key, body, opts)
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
