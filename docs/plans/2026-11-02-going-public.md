# Going public: what to do before the repo goes live

Status: notes, not started. We're still adding features; do this at launch, in one sitting.

The private repo (`netlify-labs/video-agent`) keeps its full history, including `.beads/` (touched in 41 commits)
and internal names and emails in older commits. Scrubbing today's files doesn't remove any of that from history, so
the plan is to **publish a clean snapshot as a new public repo** rather than rewrite this one.

## Why a fresh repo, not a history rewrite

- **Rewriting history** (`git filter-repo` to drop `.beads/`, `spikes/` and internal strings from every commit)
  changes every commit id, needs a force-push, breaks open PRs and clones, and GitHub keeps old commits reachable
  through PR refs and caches for a while. Every string we miss stays public forever.
- **A clean snapshot** is one commit made from a scrubbed export of `main`. Nothing from history comes along, it's
  easy to check before publishing (one tree to read), and the private repo stays our working history. The
  Deploy to Netlify button, the README and the How we built it page then point at the public repo.
- After launch, either develop in the public repo (keeping `.beads/` out of it: a private beads repo, or a beads
  sync branch only in the private repo), or keep working privately and export again for each release. Decide at
  launch.

## Checklist

### Remove from the public snapshot

- [ ] `.beads/` (task tracker: reviewer email, links to private repos, internal site names).
- [ ] `spikes/` (research code; nothing uses it, results are in `docs/spikes.md`). Drop its entries from
      `tsconfig.json` include, `eslint.config.js` ignores and `.gitignore`.
- [ ] `scripts/how-we-built-it-artifact.ts` (publishes the employees-only copy).
- [ ] Probably: `scripts/backfill-previews.ts` (one-off for old videos) and `scripts/voice-samples.py` (how the voice
      samples were made). Keep `scripts/e2e/` with a short README: they're live-site checks that spend credits.

### Scrub

- [ ] `docs/plans/`: mentions of gtm-services (`services/mcp-gateway`, `agent-skills`, `workforce-check.ts`),
      gtm-engineering, the gtm-agent-skills site and `netlify-brand`; agent run and session ids (also in
      `docs/spikes.md`). Or leave `docs/plans/` out of the public repo and keep only a short architecture doc.
- [ ] `src/auth/upstream.ts:138`: comment naming gtm-services' mcp-gateway.
- [ ] `static/how-we-built-it/index.html`: comments about "the employees' copy"; the hard-coded
      `netlify-video-agent.netlify.app` in the MCP and skill commands (fine if that site stays the public demo).
- [ ] `test/oauth.test.ts:358`: `dev@netlify.com` → an `example.com` address.
- [ ] Search the snapshot once more for: `@netlify.com`, `gtm-`, site and account ids (`3a3f4565`), `nax`,
      `netlify-labs/` links to private repos, customer names, run ids.

### Decide

- [ ] `src/generated/video-card.ts` (552 KB, committed build output): keep committed or generate in the build.
- [ ] Whether the README links the live demo (the 10-30 decision was no demo link).
- [ ] The public repo's name and org, then update the Deploy to Netlify button URL (`README.md`), the How we built it
      page's GitHub links, and `netlify.toml`/docs references.

### Check before flipping it public

- [ ] Deploy to Netlify from the public repo into a fresh team, with the three settings skipped: the sign-in screen
      lists them, `/setup` explains each.
- [ ] Then set them and make a video end to end.
- [ ] `npm ci && npm run typecheck && npm run lint && npx vitest run && npm run test:ui` in a fresh clone.
- [ ] Secret scan of the snapshot (e.g. `gitleaks detect`), even though the private repo's scan found only
      placeholder keys.

### Small code follow-up

- [ ] Planning answers: `plans.ts` drops an option with a missing label, while the copy saved with the video uses the
      option id. Make them match.
