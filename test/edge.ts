// Edge functions in tests. They read Blobs through @netlify/blobs, which a test mocks with fakeBlobsModule (backed
// by its fake store), and they're imported by a variable path: their Deno-style .ts imports aren't typechecked here.
import type { BlobStoreName } from '../src/deps.js'
import type { FakeBlobs } from './fakes.js'

export type EdgeHandler = (req: Request, ctx: { deploy: { published: boolean } }) => Promise<Response>

export const loadEdge = async (name: 'files' | 'media' | 'preview') => {
  const path = `../netlify/edge-functions/${name}.ts`
  return ((await import(/* @vite-ignore */ path)) as { default: EdgeHandler }).default
}

export const fakeBlobsModule = (blobs: () => FakeBlobs | undefined) => ({
  getStore: ({ name }: { name: BlobStoreName }) => ({
    get: async (key: string, o?: { type?: string }) => {
      const b = await blobs()?.get(name, key)
      if (!b) return null
      const text = new TextDecoder().decode(b)
      if (o?.type === 'json') return JSON.parse(text) as unknown
      if (o?.type === 'text') return text
      if (o?.type === 'stream') return new Blob([b]).stream()
      return b
    },
    getMetadata: async (key: string) => {
      const b = await blobs()?.get(name, key)
      return b ? { etag: '"e"', metadata: blobs()?.meta.get(`${name}:${key}`) ?? {} } : null
    },
  }),
})
