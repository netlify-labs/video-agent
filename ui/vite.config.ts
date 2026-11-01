import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { build, defineConfig, type Plugin } from 'vite'

/** Builds ui/src/sw/sw.ts into /sw.js: one classic script at a fixed URL, so the browser can check it for updates. */
function serviceWorker(): Plugin {
  let outDir = ''
  return {
    name: 'va-service-worker',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir)
    },
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          lib: {
            entry: resolve(import.meta.dirname, 'src/sw/sw.ts'),
            formats: ['iife'],
            name: 'vaMediaWorker',
            fileName: () => 'sw.js',
          },
        },
      })
    },
  }
}

/**
 * Mock builds under `vite preview`: /files/{job}/v{n}/{file}?exp=&sig= answered from ui/mock-assets the way the edge
 * answers it (403 for sig=bad), and a log of those requests at /__files-log, so e2e tests can drive the media worker.
 */
function mockFiles(): Plugin {
  const files: Record<string, [string, string]> = {
    'poster.jpg': ['teaser-v2.jpg', 'image/jpeg'],
    'preview.gif': ['teaser-v2.gif', 'image/gif'],
    'clip.mp4': ['teaser-v2-clip.mp4', 'video/mp4'],
    'video.mp4': ['teaser-v2.mp4', 'video/mp4'],
  }
  const log: string[] = []
  return {
    name: 'va-mock-files',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/__files-log') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(log))
          return
        }
        const url = new URL(req.url ?? '/', 'http://mock')
        const m = /^\/files\/vid_[a-z0-9]+\/v\d+\/([\w.-]+)$/.exec(url.pathname)
        const file = m?.[1] ? files[m[1]] : undefined
        if (!file) return next()
        log.push(url.pathname + url.search)
        if (url.searchParams.get('sig') === 'bad') {
          res.writeHead(403, { 'cache-control': 'no-store' }).end('This link has expired.')
          return
        }
        const body = readFileSync(resolve(import.meta.dirname, 'mock-assets', file[0]))
        res
          .writeHead(200, {
            'content-type': file[1],
            'content-length': body.length,
            'cache-control': 'private, max-age=600, immutable',
          })
          .end(body)
      })
    },
  }
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), serviceWorker(), ...(process.env.VITE_MOCK ? [mockFiles()] : [])],
  // Mock mode serves real sample posters and a real render from ui/mock-assets; production has no public dir.
  publicDir: process.env.VITE_MOCK ? 'mock-assets' : false,
  build: { outDir: 'dist', emptyOutDir: true },
  // netlify dev on :8888 serves the API, files and share pages during `vite` development.
  server: {
    proxy: {
      '^/api/': 'http://localhost:8888',
      '^/files/': 'http://localhost:8888',
      '^/v/': 'http://localhost:8888',
    },
  },
  preview: { proxy: {} },
})
