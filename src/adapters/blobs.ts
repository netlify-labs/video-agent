import { randomUUID } from 'node:crypto'
import { openAsBlob, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getStore } from '@netlify/blobs'
import type { BlobStoreName, BlobsPort } from '../deps.js'

const store = (name: BlobStoreName) => getStore({ name, consistency: 'strong' })

/**
 * Bodies above this go out as a file-backed Blob (fs.openAsBlob of a temporary file): fetch copies a buffered body
 * whole (spike D5), and the Blobs service refuses a streamed (chunked) body on Netlify (the phase 1 gate, va-rsk5.2.12:
 * "Response body object should not be disturbed or locked" after the SDK's retry). A file-backed Blob has a length, so
 * it's a plain PUT, and fetch reads it from disk (486 MB peak for 150 MB locally, against 460 MB streamed). Tests lower it.
 */
export const fileAbove = { bytes: 100 * 1024 * 1024 }

export const netlifyBlobs: BlobsPort = {
  async get(name, key) {
    const v = (await store(name).get(key, { type: 'arrayBuffer' })) as ArrayBuffer | null
    return v ? new Uint8Array(v) : null
  },
  async set(name, key, data, metadata) {
    const opts = metadata ? { metadata } : {}
    if (typeof data !== 'string' && data.byteLength > fileAbove.bytes) {
      const path = join(tmpdir(), `va-blob-${randomUUID()}`)
      writeFileSync(path, data)
      try {
        // A Blob can be read again, so the SDK's own retry is safe.
        await store(name).set(key, await openAsBlob(path), opts)
      } finally {
        rmSync(path, { force: true })
      }
      return
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
