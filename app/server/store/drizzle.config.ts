import { defineConfig } from 'drizzle-kit'

// Run from the repo root (npm run db:generate / db:check pass --config); drizzle-kit resolves these paths from there.
// Netlify only applies migrations from netlify/database/migrations.
// 20261121044159_job_runner is the baseline: the whole schema as of that date, replacing the 55 migrations before it.
// It keeps the last one's name because Netlify Database records applied migrations by name, so a database that
// already ran them treats the baseline as applied. Never rename or regenerate it; add new migrations after it.
export default defineConfig({
  dialect: 'postgresql',
  schema: './app/server/store/schema.ts',
  out: 'netlify/database/migrations',
})
