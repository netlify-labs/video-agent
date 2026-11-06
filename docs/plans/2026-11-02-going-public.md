# Going public: what to do before the repo goes live

Status (2026-11-06): **snapshot-ready, nothing published.** `npm run public-snapshot` exports `main` without the
internal paths and scans it clean (the pre-public cleanup PR, branch `chore/prepublic-cleanup`). The Decide items
below are the owner's; the Check items run after them, at launch. Paths are as of PR #2: `db/` is `src/store/`,
`spikes/` is `docs/spikes/`, `static/` is `ui/static/`.

The private repo (`netlify-labs/video-agent`) keeps its full history, including `.beads/` (touched in 53 commits)
and internal names and emails in older commits. Scrubbing today's files doesn't remove any of that from history, so
the plan is to **publish a clean snapshot as a new public repo** rather than rewrite this one.

## Why a fresh repo, not a history rewrite

- **Rewriting history** (`git filter-repo` to drop `.beads/` and internal strings from every commit) changes every
  commit id, needs a force-push, breaks open PRs and clones, and GitHub keeps old commits reachable through PR refs
  and caches for a while. Every string we miss stays public forever.
- **A clean snapshot** is one commit made from a scrubbed export of `main`. Nothing from history comes along, it's
  easy to check before publishing (one tree to read), and the private repo stays our working history. The
  Deploy to Netlify button, the README and the How we built it page then point at the public repo.
- After launch, either develop in the public repo (keeping `.beads/` out of it: a private beads repo, or a beads
  sync branch only in the private repo), or keep working privately and export again for each release. Decide at
  launch.

## The snapshot script

`scripts/public-snapshot.ts` (`npm run public-snapshot -- <out dir> [--ref origin/main]`, or `--scan <dir>` to scan
a folder) runs `git archive` of the ref into a new or empty folder and then scans it. It never pushes, creates a repo
or changes visibility.

- **Left out** (`EXCLUDES`, one entry per path with why): `.beads/`, `scripts/how-we-built-it-artifact.ts`,
  `scripts/backfill-previews.ts`, `scripts/voice-samples.py`, and the snapshot tooling itself (the script, its test
  and this plan, which spell out the strings the scan looks for). A test fails if an excluded path stops existing,
  so a move can't quietly publish it.
- **Scanned for** (`RULES`): company emails, internal team, service and site names, the production site id, the
  internal CLI, Netlify agent run, session and deploy ids (24 hex characters), GitHub Actions run ids, links to
  private `netlify-labs/` repos (the repo itself may be named: its public name is a Decide item), people's handles,
  customer names (a list to extend), home directories, and token-shaped strings. Obvious fakes in tests (a run of one
  character, `notareal…`) aren't hits. It also runs `gitleaks dir` when gitleaks is installed (and says so when it
  isn't), with `.gitleaks.toml` allowing the two fake secrets the tests use.
- Each hit prints as `file:line  rule  text`; any hit exits 1. Before the cleanup PR: 54 hits in 17 files. After: 0.

## Checklist

### Remove from the public snapshot

- [x] `.beads/` (task tracker: reviewer email, links to private repos, internal site names). It stays tracked here.
- [x] `scripts/how-we-built-it-artifact.ts` (publishes the employees-only copy).
- [x] `scripts/backfill-previews.ts` (one-off for old videos) and `scripts/voice-samples.py` (how the voice samples
      were made). `scripts/backfill-beats.ts` stays: a deployment upgraded from before scene lists may need it.
- [ ] `docs/spikes/` stays in the snapshot, scrubbed (PR #2 moved it there on purpose; `tsconfig.json`,
      `eslint.config.js` and `.gitignore` already point at the new path). Leaving it out would also mean dropping
      those entries. Decide below.
- [ ] Keep `scripts/e2e/` with a short README: they're live-site checks that spend credits.

### Scrub (done in the cleanup PR; the scan keeps it done)

- [x] `docs/plans/`: internal service, team and site names, the internal monorepo's site service and its PR and
      commit refs, agent run, session and runner ids, the internal agent-run CLI, a test site and test account.
- [x] `docs/spikes.md` and `docs/spikes/`: run, session, deploy and CI run ids, a private template repo, the test
      account, a person's handle, the production site id in `docs/spikes/e3/poc-launch.ts` (now `SITE_ID`).
- [x] `src/auth/upstream.ts`, `test/oauth.test.ts` (now `dev@example.com`), `ui/src/session.ts`: comments naming
      internal services.
- [x] `ui/static/how-we-built-it/index.html`: the comments about "the employees' copy". The hard-coded
      `netlify-video-agent.netlify.app` in its MCP and skill commands stays while that site is the public demo.
- [x] `ui/src/mock/data.ts`: a real deploy id in the mock data.
- [x] `scripts/e2e/github-action.ts`: the private sandbox repo in its usage line.

### Added since this plan was first written (check each at launch)

- **`looks/`** (9 looks, with fonts and samples): each has `assets/credits.json`; confirm every bundled font and
  image there is redistributable.
- **`packages/`**: the SDK (`netlify-video-agent-sdk`), CLI (`netlify-video-agent`, with `video-agent local`, local
  mode on your own machine), player (`netlify-video-agent-player`) and the private GitHub Action
  (`packages/action`, with its committed `dist/index.cjs`). Their `package.json` repository, homepage and bugs links
  name `netlify-labs/video-agent`.
- **The GitHub Action** is used as `netlify-labs/video-agent/packages/action@<sha>`; tags `action-v1.0.0` and
  `action-v1` exist only in this private repo, and the README examples pin a commit of it.
- **WebMCP** (browser agents, admin switch), **screen recordings** (demo from a recording, privacy mode),
  **engines** (`engines/remotion`, with the Remotion license notice in `src/lib/remotion-notice.ts`).
- **Bead ids in comments** (`va-…`, in about 240 files under `src/`, `ui/`, `packages/` and `scripts/`): harmless,
  but they point at a tracker the public can't see.
- **Media**: voice samples in `ui/src/assets/voices`, mock GIFs in `ui/mock-assets`, test fixtures under
  `test/fixtures`: confirm each is ours or openly licensed.
- **Left open by the build-out** (in `.beads/`): `va-lvd.5` (open-source readiness), `va-uys.9` (the Deploy to
  Netlify button from a public repo), `va-p1th.1.4` (npm name placeholders), `va-p1th.8.2` and `va-p1th.8.6` (npm
  releases, which wait for the public repo), `va-mg4i.5.5` (the action installed from its README by someone outside
  the team; the owner runs it).

### Decide

- [ ] `src/generated/video-card.ts` (564 KB, committed build output): keep committed or generate in the build.
      (`packages/action/dist/index.cjs` has to stay committed: GitHub runs the action from the repo.)
- [ ] Whether the README links the live demo (the 10-30 decision was no demo link).
- [ ] The public repo's name and org, then update the Deploy to Netlify button URL (`README.md`), the How we built it
      page's GitHub links, the packages' repository links, the action's `uses:` path and pinned commit
      (`packages/action/src/examples.ts`, its README and `/docs/github`), and `netlify.toml`/docs references.
- [ ] The action's release tags in the public repo (re-create `action-v1.0.0` and `action-v1` there, or start at a
      new version).
- [ ] Whether `docs/plans/` and `docs/spikes/` go public (scrubbed now) or the public repo keeps only a short
      architecture doc.
- [ ] Whether bead ids stay in comments.
- [ ] When the npm packages publish (after the public repo exists, with provenance; `va-p1th.8.6`).
- [ ] What happens to the private sandbox repos used for the action's live tests.

### Check before flipping it public

- [ ] `npm run public-snapshot -- <dir>` prints "clean: no hits" (gitleaks included).
- [ ] Deploy to Netlify from the public repo into a fresh team, with the three settings skipped: the sign-in screen
      lists them, `/setup` explains each.
- [ ] Then set them and make a video end to end.
- [ ] `npm ci && npm run typecheck && npm run lint && npx vitest run && npm run test:ui` in a fresh clone of the
      snapshot.

### Small code follow-up

- [ ] Planning answers: `plans.ts` drops an option with a missing label, while the copy saved with the video uses the
      option id. Make them match.
