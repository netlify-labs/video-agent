import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  // Mock mode serves real sample posters and a real render from ui/mock-assets; production has no public dir.
  publicDir: process.env.VITE_MOCK ? 'mock-assets' : false,
  build: { outDir: 'dist', emptyOutDir: true },
  // netlify dev on :8888 serves the API, files and share pages during `vite` development.
  server: { proxy: { '^/api/': 'http://localhost:8888', '^/files/': 'http://localhost:8888', '^/v/': 'http://localhost:8888' } },
  preview: { proxy: {} },
})
