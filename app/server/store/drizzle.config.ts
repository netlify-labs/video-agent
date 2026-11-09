import { defineConfig } from 'drizzle-kit'

// Run from the repo root (npm run db:generate / db:check pass --config); drizzle-kit resolves these paths from there.
// Netlify only applies migrations from netlify/database/migrations.
export default defineConfig({
  dialect: 'postgresql',
  schema: './app/server/store/schema.ts',
  out: 'netlify/database/migrations',
})
