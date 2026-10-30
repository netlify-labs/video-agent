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
}
