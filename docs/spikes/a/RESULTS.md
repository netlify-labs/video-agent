# Spike results A1–A4 (raw notes, 2026-11-05)

Sandbox repos (private, `netlify-labs`): `video-agent-action-sandbox` (A3, A4, A1) and `video-agent-action-consumer`
(A2). Throwaway branch `spike/a2` and tags `action-v0.0.1`, `action-v0.0.2` on `netlify-labs/video-agent`. These
notes feed the plan's "Spike results" section (`va-mg4i.1.5`).

## A2. Install path: done

| Check                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions access `none` (today's setting)                    | Fails at "Set up job": `Unable to resolve action netlify-labs/video-agent, repository not found`                                                                                                                                                                                                                                                                                         |
| Access `organization`                                      | `uses: netlify-labs/video-agent/spikes/a/hello-action@<full sha>` and `@action-v0.0.1` both resolve and run                                                                                                                                                                                                                                                                              |
| Runtime                                                    | `runs.using: node24` ran on Node v24.22.1                                                                                                                                                                                                                                                                                                                                                |
| Committed `dist/`                                          | **The root `.gitignore` has `dist/`**, so `git add` silently skips the bundle and the action fails with `File not found: …/dist/index.cjs`. Phase 1 (`va-mg4i.2.1`) needs `!packages/action/dist/` in `.gitignore` and a test that the bundle is tracked                                                                                                                                 |
| Bundle format                                              | The root `package.json` is `"type": "module"`, so a CommonJS bundle must be `.cjs` (or the package gets its own `package.json`)                                                                                                                                                                                                                                                          |
| Dependabot (`github-actions`, SHA pin + `# action-v0.0.1`) | Doesn't update while the repo is private: `git_dependencies_not_reachable` (401/404 on `netlify-labs/video-agent.git`) even with Actions access `organization`. Dependabot reads private repos only through the org's separate "Grant Dependabot access to private repositories" setting (not changed here). Retest after going public; until then the README documents manual SHA bumps |

Access setting steps (for the README): Settings → Actions → General → Access → "Accessible from repositories in the
'netlify-labs' organization", or the command below. It was put back to `none` after the spike; phase 1's live test
turns it on again.

```sh
gh api -X PUT repos/netlify-labs/video-agent/actions/permissions/access -f access_level=organization
```

## A3. Token permissions and the permission endpoint: done for a private org member; outside account pending

The PR author, sender and commenter was DavidWells: a `netlify-labs` member whose membership is **private**
(`/orgs/netlify-labs/members/DavidWells` 204, `/public_members/DavidWells` 404) and admin of the sandbox repo.

| Operation                                                                 | `{}` | `pull-requests: write` | `issues: write` | `contents: write` |
| ------------------------------------------------------------------------- | ---- | ---------------------- | --------------- | ----------------- |
| `GET /repos/{r}/collaborators/{login}/permission`                         | 200  | 200                    | 200             | 200               |
| Create, edit, list, delete a PR comment (`pull_request`, `issue_comment`) | 403  | 201/200/200/204        | 403             | 403               |
| React to a PR comment (`issue_comment`)                                   | 403  | 201                    | 403             | 403               |
| Edit a release body (`release`)                                           | 403  | 403                    | 403             | 200               |
| Upload a release asset (`release`)                                        | 403  | 403                    | 403             | 201               |
| `GET /user`                                                               | 403  | 403                    | 403             | 403               |

- The permission endpoint needs **only metadata read** (`permissions: {}` works) and said `admin` for the private
  member.
- `author_association` for the same person: **`CONTRIBUTOR` on the PR** (`pull_request.author_association`) and
  `MEMBER` on their comment. That confirms §4.5: `author_association` can't be trusted to recognise members; the
  permission endpoint can.
- **`issues: write` isn't needed.** Comments and reactions on PR comments work with `pull-requests: write` alone, and
  `issues: write` alone is refused. The example workflows can drop `issues: write`.
- Comments made with `GITHUB_TOKEN` are by `github-actions[bot]` (type `Bot`); `GET /user` is 403, so 1.5 matches the
  sticky comment by that login plus the marker.
- Rate limit: this org's `GITHUB_TOKEN` core limit is **15,000/hour** (Enterprise Cloud), not 1,000; the plan's
  1,000 stays the design budget for other orgs.

Outside account (`netliclaw`, a real user with no access to the repo), through `A3_LOGINS` on a `workflow_dispatch`
run with `permissions: {}`: the endpoint answers **200 with `permission: none`** (and an empty `role_name`), not 404.
So 1.3's trust check reads the value: only `write`, `maintain` and `admin` are trusted; `none`, `read`, `triage`, a
404 and any other answer are not.

A fork PR can't be tested while the sandbox is private (the outside account can't see it, so it can't fork it). The
fork rules come from GitHub's docs (§1) and are covered by the event-router fixtures; retest on a public sandbox
after going public.

## A4. Private attachments: done

A PNG pasted into PR #1's description (a private repo) became
`<img src="https://github.com/user-attachments/assets/<uuid>">`. The probe (run 41979953547, `contents: read`,
`pull-requests: read`):

| Method                                                 | Result                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `user-attachments` URL, no auth                    | 404 from `github.com`                                                                                                                                      |
| The same URL with `Authorization: Bearer GITHUB_TOKEN` | 404 from `github.com`                                                                                                                                      |
| GraphQL `pullRequest.bodyHTML` (with `GITHUB_TOKEN`)   | Rewrites the image to a signed `private-user-images.githubusercontent.com/…?jwt=…` URL; downloading it with **no auth** is 200, `image/png`, 655,960 bytes |

- The signed URL's JWT lives **300 seconds**, so 1.9 reads `bodyHTML` and downloads right away (no caching of the URL).
- 1.9's method: for private repos (or whenever a `user-attachments` link 404s), fetch `bodyHTML` with the token and
  download its `private-user-images.githubusercontent.com` URLs **without** any `Authorization` header. The token never
  goes to an image host. Alt text comes from the markdown body (match by order), not from `bodyHTML`.
- `pull-requests: read` (already implied by `pull-requests: write`) is enough for the GraphQL call.

## A1. GIFs in comments: answered (one check still running)

Video `vid_01m6hxhj2x90gfgj49aeemhp8d` v2 ("Netlify Agent Runners GitHub Action", not public before) was published as
`/v/tvrbu5qmfy` at 06:25Z, its GIF posted on sandbox PR #1 (comment 6651348820), and unpublished at about 06:26Z.

| Check                         | Result                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rendering                     | GitHub proxies it through `camo.githubusercontent.com` (200, `image/gif`, the same 149,094 bytes). The owner confirmed it shows and animates on desktop. Mobile app and email not checked (the comment was posted as the owner, so no email) |
| After unpublish, the origin   | 404 from the first check (06:26Z) on                                                                                                                                                                                                         |
| After unpublish, camo         | Still 200 at 06:26Z (cached), **404 by 06:36Z** and every 10 minutes after, through 07:26Z                                                                                                                                                   |
| Editing the comment at 07:26Z | Done; the post-edit hour (to about 08:27Z) is in `a1-linger.log` and wasn't read before close-out                                                                                                                                            |
| Size limit                    | Not tested                                                                                                                                                                                                                                   |

What it changes:

- §3.9 stands: a published GIF works in the sticky comment.
- §2.3 and §4.9 were too pessimistic. GitHub's proxy follows an unpublish within about 10 minutes (the proxy
  revalidates; it doesn't keep its own copy). A browser that already loaded the image may still show its own cached
  copy. The README can say "an unpublished GIF stops showing in comments within minutes"; publishing stays off by
  default for the other reasons (a public page and MP4).

## Owner decision (2026-11-05): no Dependabot

Dependabot is out. The README documents bumping the SHA pin by hand (and Renovate for teams that want automation).
The throwaway branch `spike/a2` and tags `action-v0.0.1`/`action-v0.0.2` were deleted after the spike.
