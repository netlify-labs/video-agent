# Spikes A1–A4: GitHub facts the action relies on

Plan: [docs/plans/2026-11-04-github-action.md](../../docs/plans/2026-11-04-github-action.md) §10 phase 0. Beads
`va-mg4i.1.1`–`1.4`; results go into the plan's "Spike results" section (`va-mg4i.1.5`). Nothing here ships, and no
spike starts a video run (no credits).

Every spike needs things on GitHub that only the owner can set up or approve: sandbox repos, an org setting, a
throwaway branch on `netlify-labs/video-agent`, and a second (and third) GitHub account. Each section lists them.

## A1. Preview GIFs in PR comments

Needs: one **already ready** video on the production site that's fine to publish briefly, and a sandbox repo with an
open PR (A3's or A4's repo will do).

1. Publish the video in the app; note its slug.
2. `node spikes/a/scripts/a1-watch.mjs post <owner/repo> <pr> <site> <slug>`: posts the comment, prints the camo URL
   and both fetches.
3. Look at the comment on desktop, the GitHub mobile app and the email notification. Screenshot each.
4. Unpublish in the app, then `node spikes/a/scripts/a1-watch.mjs watch <owner/repo> <comment-id> 120 10` (JSON lines
   every 10 minutes for 2 hours). Edit the comment once during the run to see whether an edit refreshes it.
5. Size limit: make a ~5 MB GIF locally, upload it anywhere public (or a GitHub attachment) and post it the same way.

## A2. Install path (sub-folder action, SHA pin, prefixed tags)

Today `GET /repos/netlify-labs/video-agent/actions/permissions/access` says `access_level: none`, so other repos in
the org can't use its actions yet.

Needs:

- a throwaway branch `spike/a2` on `netlify-labs/video-agent` carrying `spikes/a/hello-action/` (no app code
  changes; branch pushes don't deploy production), and a tag `action-v0.0.1` on it, later `action-v0.0.2`;
- a second private repo in `netlify-labs` (the consumer) with `workflows/a2-consumer.yml` (with `<sha>` filled in) and
  `workflows/a2-dependabot.yml` as `.github/dependabot.yml`;
- the Actions access setting switched to "Accessible from repositories in the netlify-labs organization" (Settings →
  Actions → General → Access, or the command below), after first running the consumer with it off.

```sh
gh api -X PUT repos/netlify-labs/video-agent/actions/permissions/access -f access_level=organization
```

Record: does it run with the setting off (expected: no) and on; does the prefixed tag resolve; after
`action-v0.0.2`, does Dependabot open a PR updating the SHA and the `# action-v0.0.1` comment. Afterwards delete the
branch, both tags and the consumer repo, and put the access setting back unless phase 1 needs it.

## A3. Token permissions and the permission endpoint

Needs: a sandbox repo in an org **where the test member's membership is private**, with:

- a member account with write access through a team (membership set to private), and an outside account with no
  access;
- `workflows/a3-probe.yml` as `.github/workflows/a3-probe.yml` (regenerate it with
  `python3 spikes/a/scripts/gen-a3-workflow.py` after editing the probe), and a repo variable `A3_LOGINS` with both
  logins;
- then: the member opens a PR, adds a label, and comments on it; the outside account comments too (and, if possible,
  opens a fork PR); someone publishes a release.

Each job writes a table to its job summary: every operation's status under that `permissions:` block, what
`author_association` and the permission endpoint say for each login, the comment's author login, and `GET /user`.
Paste the summaries into the results.

## A4. Private attachments

Needs: a **private** sandbox repo (can be A3's) with `workflows/a4-probe.yml` and `scripts/a4-probe.mjs` at
`.github/a4-probe.mjs`, and a PR whose description has a PNG dragged into the editor (a `user-attachments` link).

The job summary shows, per image: no auth, `Bearer GITHUB_TOKEN` (sent to the first host only), and the signed URL
from GraphQL `bodyHTML`, with every redirect hop. Re-run the job after 10 minutes and after an hour.
