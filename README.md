# Video Agent

Your company's own video agent on Netlify. Your team signs in, describes a video, and gets an MP4 a few
minutes later, made by an AI agent with [HyperFrames](https://hyperframes.heygen.com) (an open-source HTML-to-video renderer;
no account needed) in a
[Netlify Agent Runner](https://docs.netlify.com/build/build-with-ai/agent-runners/overview/). Revise it
in plain words, publish it to a public link with a share page, or drive everything from scripts with an
API key.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/netlify-labs/video-agent)

## What you get

- **A web app** for your team: write a prompt, pick a shape (16:9, 9:16, 1:1, 4:5), watch it being made, play and download the result (MP4, poster, GIF preview, captions).
- **Revisions:** "make the end card orange" starts a new version from the previous one's composition. Every version keeps its prompt and author.
- **Publishing:** any version can get a public share page (with link previews for Slack and social), a raw MP4 URL, a GIF and an embed snippet. Unpublishing takes the link down immediately.
- **An API** with API keys and signed webhooks, so CI and scripts can make videos too. Its reference is built into the app (**API docs**).
- **MCP tools**, so people can ask Claude, Cursor or any MCP client for a video.
- **Your brand:** put your brand guide, logos and fonts in [`context/`](context/README.md). Every video follows it.
- **A media library** of logos, screenshots, clips, fonts and music, with **Find music**: CC0 and CC BY tracks from
  [Openverse](https://openverse.org), credited automatically ([below](#music-from-openverse)).

## Before you deploy

Have these ready before you press the button:

- A Netlify team on a **credit-based plan** with **AI features** and **Agent Runners** available, and AI credits.
  To check, open any project in the team: if it has an **Agent Runs** tab, you're set. Each video costs roughly
  90–210 credits in our tests (more for long or complex videos), billed to the team's AI credits; nothing else is
  billed. There are **no spending limits in this template**: use your team's credit controls.
- A **GitHub** account. The project must be connected to a GitHub repo, because Agent Runners work from Git.
- A **personal access token** for starting runs. We recommend a dedicated Netlify account for it: invite that
  account to your team first, sign in as it, then create the token at
  [User settings → Applications](https://app.netlify.com/user/applications). It's a user-level token: anyone who
  can read this project's environment can use it.

## Deploy

**With the button:** press Deploy to Netlify above. It copies this repo to your GitHub and asks for:

| Variable                | What to enter                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `RUNNER_API_TOKEN`      | The personal access token.                                                               |
| `ALLOWED_EMAIL_DOMAINS` | Your company's email domains, comma-separated (`acme.com,acme.co.uk`), or `invite-only`. |
| `ADMIN_EMAILS`          | The first admins' email addresses, comma-separated.                                      |

Then follow the page Netlify shows after the deploy (it's [`USAGE.md`](USAGE.md)): enable **Identity**, set its
registration mode, open `https://<your-site>/setup` and create the first admin account. The setup page checks
everything and links to whatever is left.

**From a clone:** push the clone to a GitHub repo of your own first, then:

```sh
npm ci
npx netlify login
npm run setup -- --team <your-team-slug>   # or --site <existing project> to reuse one
```

`npm run setup` creates (or reuses) the project, asks for the three values above, saves them, enables Identity,
offers to register an Openverse app for music search and, once the project is connected to your GitHub repo, starts a production build and runs the setup checks. The
first time, it stops and tells you where to link the repo; run it again with the `--site` it prints. Then
follow steps 1 and 3 of [`USAGE.md`](USAGE.md) for the registration mode and the first admin.

Either way, the database (Netlify Database) is created and its tables are migrated automatically by the
production build from Git (the migrations are in `netlify/database/migrations/`). There's nothing to run by hand.

## Who can sign in

Sign-in uses [Netlify Identity](https://docs.netlify.com/manage/security/secure-access-to-sites/identity/overview/)
by default. A deployment can use **Sign in with Netlify** (Netlify OAuth) instead, optionally limited to members of a
Netlify team: see [Sign in with Netlify for the web app](#sign-in-with-netlify-for-the-web-app). Forks keep Identity
unless they set `AUTH_PROVIDER=netlify`.

With Identity, `ALLOWED_EMAIL_DOMAINS` picks one of two modes:

- **Company domains** (`acme.com`): anyone with an `@acme.com` address can create an account and must confirm their email. Keep Identity's **autoconfirm off**, or people could claim addresses they don't own. Other domains are refused at sign-up and by the API.
- **`invite-only`**: set Identity registration to **Invite only** and invite people from the Identity tab. Nobody else can sign up.

`ADMIN_EMAILS` become admins on their first sign-in; everyone else joins as a **Creator**. Admins change roles on the
Admin page:

| Role         | Can                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| **Admin**    | Everything: people and roles, settings, usage, stopping runs, owner actions on any video                 |
| **Creator**  | Make, revise and plan videos (spends credits); rename, publish, delete and make private their own videos |
| **Reviewer** | Watch videos and give feedback; never spends credits                                                     |
| **Viewer**   | Watch videos                                                                                             |

API keys and the MCP server act with their owner's role. Disabling someone also revokes their API keys.

**Private videos** are hidden from everyone except their owner and admins: they don't appear in other people's
Library, search, API or MCP results. Private means hidden in the app among trusted colleagues, not confidential:
agent runs in this project can read the project's storage, so a Creator could have a run fetch another video's files.
A private video can still be published to a public link; publishing is a separate, explicit step.

## How it works

```
prompt ─► POST /api/v1/videos ─► queue ─► Agent Runner run (on this same project, from the production deploy)
                                            │ reads context/, writes video/index.html, `hyperframes check`
                                            │ scripts/render-job.ts: render → poster, GIF, captions → upload to Blobs
                                            ▼
          web app / API ◄── ready ◄── finalize (verify hashes and the MP4) ◄── callback + a sweep every minute
```

- One repo, one Netlify project. Records live in Netlify Database, files in Netlify Blobs.
- At most `MAX_ACTIVE_RUNS` (default 3) runs at once; the rest wait in a queue.
- A scheduled sweep (every minute) owns every outcome: lost callbacks, crashed starts, runs that ask questions or run too long are all handled. Nothing retries automatically; people get a **Try again** button.
- Only the published production deploy serves the API and files. Deploy previews (including the ones agent runs create) get a copy of the database, so they serve nothing.

### Trust model, plainly

Agent runs in this project can read the project's environment variables, like any Netlify build. That includes
`RUNNER_API_TOKEN`. Only signed-in people from your allowed domains (or invited people) can start runs, and every
output is verified (hashes against the run's authenticated report, a real MP4 check) before it becomes a video.
Prompts are visible to your Netlify team in the project's Agent Runs page.

## Configuration

| Variable                                                 | Default                                        | Meaning                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNNER_API_TOKEN`                                       | —                                              | Personal access token for starting and watching runs.                                                                                          |
| `ALLOWED_EMAIL_DOMAINS`                                  | —                                              | Company domains, or `invite-only`.                                                                                                             |
| `ADMIN_EMAILS`                                           | —                                              | First admins.                                                                                                                                  |
| `MAX_ACTIVE_RUNS`                                        | `3`                                            | Runs at once.                                                                                                                                  |
| `AGENT`, `AGENT_MODEL`, `AGENT_EFFORT`                   | runner default                                 | Which agent makes videos.                                                                                                                      |
| `AUTHORING_DEADLINE_MIN`                                 | `22`                                           | Stop a run after this many minutes (the runner's ceiling is 25).                                                                               |
| `QUEUE_TIMEOUT_MIN`                                      | `60`                                           | Fail a video that waits in the queue longer than this.                                                                                         |
| `RENDER_QUALITY`                                         | `standard`                                     | HyperFrames render quality (`looks`, `standard`, `delivery`).                                                                                  |
| `ALLOWED_ORIGINS`                                        | —                                              | Origins allowed to call the API from a browser with an API key (CORS).                                                                         |
| `BRAND_ZIP_URL`                                          | —                                              | A zip of your brand kit, used instead of committing it to `context/` ([how](context/README.md#keeping-your-brand-out-of-the-repo)).            |
| `AUTH_PROVIDER`                                          | `identity`                                     | How people sign in to the web app: `identity` (Netlify Identity) or `netlify` ([Sign in with Netlify](#sign-in-with-netlify-for-the-web-app)). |
| `NETLIFY_REQUIRED_TEAM`                                  | —                                              | Netlify team slugs or ids (comma-separated). When set, every Netlify sign-in (web or MCP) must be a member of one; re-checked daily.           |
| `MCP_OAUTH_PROVIDER`                                     | `netlify` with `AUTH_PROVIDER=netlify`, else — | `netlify` turns on OAuth for the MCP ([below](#sign-in-with-netlify-oauth)); `off` turns it off. Off unless both credentials are set.          |
| `NETLIFY_OAUTH_CLIENT_ID`, `NETLIFY_OAUTH_CLIENT_SECRET` | —                                              | The Netlify OAuth application for Sign in with Netlify (web and MCP share it).                                                                 |
| `MCP_OAUTH_ALLOWED_EMAIL_DOMAINS`                        | `ALLOWED_EMAIL_DOMAINS`                        | Email domains that may connect over OAuth. With neither set to domains (`invite-only`), only existing accounts can.                            |
| `MCP_OAUTH_CIMD_HOSTS`                                   | `claude.ai,claude.com`                         | Hosts whose https client ids (Client ID Metadata Documents) are fetched.                                                                       |
| `OPENVERSE_CLIENT_ID`, `OPENVERSE_CLIENT_SECRET`         | —                                              | A registered Openverse app for Find music (higher rate limits). Without them, searches are anonymous ([below](#music-from-openverse)).         |

## Music from Openverse

Creators and admins can search [Openverse](https://openverse.org) from the Media page (**Find music**), the media
picker, or the MCP tools `search_music` and `import_music`. Every call goes through the server
(`GET /api/v1/media/openverse/search`, `POST /api/v1/media/openverse/import`); the browser never talks to the
Openverse API.

- **Licences: CC0 and CC BY only.** NC (non-commercial), ND (no derivatives) and SA (share-alike) tracks are never
  shown or imported, whatever Openverse returns: videos are often commercial, they're edited and re-cut, and a
  share-alike track would put its licence on the whole video. CC0 needs no credit; CC BY needs one, which the app adds.
- **Import** takes only the Openverse id. The server reads the track from Openverse again, checks the licence,
  downloads the file over HTTPS (at most 3 redirects, 50 MB, 25 seconds; hosts that resolve to private addresses are
  refused) and keeps it only if its bytes are MP3, M4A, WAV or Ogg audio of 10 minutes or less. It becomes a normal
  library item with its source, licence, creator and Openverse's attribution recorded. Importing the same track again
  returns the same item.
- **Attribution** comes from the library, not from the agent: a version made with a CC BY item lists it in the
  version's `credits`, the video page shows "Music: _title_ by _creator_, CC BY 4.0" with links, and the public share
  page and the embed snippet carry the same line. A silent version isn't credited for a track it never used.
- **Previews** play from the track's source site (Jamendo, Freesound, Wikimedia Commons) when someone presses play.
- **Rate limits.** Anonymous Openverse access is limited per IP address, and Netlify Functions share outbound
  addresses, so register an app for steady use. One command does it and stores the credentials on your project
  (the secret is never printed):

  ```sh
  npm run setup:openverse -- --site <your project> --deploy
  ```

  It asks for an email (or reads `OPENVERSE_EMAIL`), registers an app named after your site (names are unique
  across Openverse; pass `--name` to choose another), sets `OPENVERSE_CLIENT_ID` and `OPENVERSE_CLIENT_SECRET`,
  and with `--deploy` redeploys so the functions pick them up. Then click the verification link Openverse emails
  you: until then the app has anonymous limits. `npm run setup` offers the same step, and the setup page shows
  whether searches run as a registered app. The server swaps the credentials for a token and keeps it until it
  expires. Searches are cached for 5 minutes, and when Openverse says it's busy the app waits before asking again
  and says "Openverse is busy, try again in a minute."

## The API

Reference: the app's **API docs** page (`/docs`), built from the OpenAPI spec at `/api/openapi.json` (committed as
[`openapi.json`](openapi.json)). A standalone copy is at `/api/docs`.

```sh
KEY=nva_...   # create one on the API keys page
curl -X POST https://<site>/api/v1/videos -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"A 20-second launch video for our new webhooks feature","aspect":"16:9","webhookUrl":"https://example.com/hook"}'
curl -H "Authorization: Bearer $KEY" https://<site>/api/v1/videos/<id>                       # poll until "ready"
curl -L -H "Authorization: Bearer $KEY" https://<site>/api/v1/videos/<id>/versions/1/video -o video.mp4
```

Webhooks (`video.ready`, `video.failed`) are signed: `X-Video-Agent-Signature: t=<unix>,v1=<hex>` where the hex
is HMAC-SHA256 of `"<t>.<raw body>"` with the key's webhook secret (shown once when the key is created). Dedupe on
`eventId`; retries continue for 24 hours.

## Use it from AI tools (MCP)

The same video tasks are MCP tools, so people can ask Claude, Cursor or any MCP client for a video:
`create_video`, `get_video`, `list_videos`, `revise_video`, `publish_video`, `unpublish_video`, `cancel_video`,
`set_verdict`, `list_media`, `search_music` and `import_music` (CC0 and CC BY music from Openverse), and, when AI
Gateway is available, `plan_video` and `plan_brief` (ask a few questions first, then create with the plan). Each key's tool list matches its owner's role: Reviewers see the read and review tools, Viewers read only.

- Server URL: `https://<your-site>/mcp` (Streamable HTTP). Authenticate with an API key: `Authorization: Bearer nva_…`,
  or, when it's on, [Sign in with Netlify](#sign-in-with-netlify-oauth).
- Claude Code: `claude mcp add --transport http video-agent https://<your-site>/mcp --header "Authorization: Bearer nva_…"`
- Cursor and others (`mcp.json`): `{ "mcpServers": { "video-agent": { "url": "https://<your-site>/mcp", "headers": { "Authorization": "Bearer nva_…" } } } }`
- Stdio-only clients: `npx -y mcp-remote https://<your-site>/mcp --header "Authorization: Bearer nva_…"`

The web app's **API docs** page has the REST reference and these instructions with your site's URL filled in.

### Agent skills and MCP prompts

Each deployment serves a `netlify-video` [Agent Skill](https://agentskills.io) that teaches coding agents (Claude
Code, Codex, Cursor, Gemini CLI) the good path: connecting, plan → create → follow → publish, asking before spending
a run, reusing library media, and recipes for a pull request → demo video, release notes → changelog video, a
15-second vertical cut, localising captions and a review loop. The source is `skills/netlify-video/`; the build
packages it as `https://<your-site>/skills/netlify-video.zip` (listed with its sha256 in `/skills/index.json`) with
your site's URL filled in, so forks serve their own. The zip is deterministic: the same sources and URL give the same
bytes.

```sh
curl -fsSL https://<your-site>/skills/netlify-video.zip -o /tmp/netlify-video.zip \
  && unzip -o /tmp/netlify-video.zip -d ~/.claude/skills/
```

The API docs page has the command for each agent. The same recipes are MCP prompts (`pr_video`, `changelog_video`,
`social_cut`, `localize_video`, `review_video`) for clients without skills, filtered by role like the tools.

### Sign in with Netlify (OAuth)

Optional. With it on, clients that only do OAuth (Claude and ChatGPT web connectors) can connect with the URL alone:
the person signs in with Netlify, approves the app, and the app acts as them with their role. API keys keep working
exactly as before; with it off, nothing changes (the OAuth routes return 404).

1. Create a Netlify OAuth application (User settings → Applications → OAuth → New OAuth app) with the redirect URI
   `https://<your-site>/oauth/callback`.
2. Set `MCP_OAUTH_PROVIDER=netlify`, `NETLIFY_OAUTH_CLIENT_ID` and `NETLIFY_OAUTH_CLIENT_SECRET` (mark the secret as
   secret), and optionally `MCP_OAUTH_ALLOWED_EMAIL_DOMAINS`, then redeploy.

The server advertises itself at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`,
takes Dynamic Client Registration (`/oauth/register`) and Client ID Metadata Documents from `MCP_OAUTH_CIMD_HOSTS`,
and issues opaque tokens bound to `https://<your-site>/mcp`: access tokens last an hour, refresh tokens 30 days and
rotate on every use (a reused one ends the connection). Public clients with PKCE (S256) only. A verified email maps to
the person's account; a first-time address in an allowed domain gets an account with the Creator role, like web
sign-up. People see and revoke their connected apps on the API keys page; disabling someone ends their connections.
Each Netlify sign-in is linked to one account per person: a person who signs up on the web later with the same
address keeps one account, because their next Netlify sign-in merges the OAuth-created account into the web one (see
below). With `NETLIFY_REQUIRED_TEAM` set, MCP sign-ins must be in that team too, whichever `AUTH_PROVIDER` is used.

### Sign in with Netlify for the web app

Set `AUTH_PROVIDER=netlify` and the web app signs people in with their Netlify account instead of Netlify Identity
(Identity isn't used for sign-in at all, and the setup page checks the OAuth app instead of Identity). MCP OAuth
turns on with it, using the same OAuth app.

1. Create a Netlify OAuth application (User settings → Applications → OAuth → New OAuth app) with the redirect URI
   `https://<your-site>/oauth/callback`. That one URI serves both the web sign-in and MCP OAuth (the web sign-in is
   told apart by a signed cookie in the browser that started it), so it's the only one to register.
2. Set `AUTH_PROVIDER=netlify`, `NETLIFY_OAUTH_CLIENT_ID` and `NETLIFY_OAUTH_CLIENT_SECRET` (mark the secret as secret).
3. Keep `ALLOWED_EMAIL_DOMAINS` and `ADMIN_EMAILS`: they apply as before, to the email on the Netlify account.
   `invite-only` admits only people who already have an account here, plus `ADMIN_EMAILS` (there are no invites
   without Identity), so a team rule is usually the better fit.
4. Optionally set `NETLIFY_REQUIRED_TEAM` to your Netlify team's slug (as in `app.netlify.com/teams/<slug>`) or id,
   comma-separated for several. Then redeploy.

How it behaves:

- **Sign-in:** the button goes to `/auth/netlify/start`, Netlify, then `/oauth/callback`, which checks the email
  domain and the team, links or creates the account and sets the session. A refused sign-in comes back to the
  sign-in page with the reason.
- **Sessions:** an opaque random token in the `va_session` cookie (httpOnly, Secure, SameSite=Lax), stored only as a
  hash. A session lasts 30 days from its last use, its token is replaced daily, and it ends on Sign out
  (`POST /auth/sign-out`) or when an admin disables the person (which also ends their MCP connections and API keys).
  Requests that change something must come from the app's own origin, as with Identity.
- **MCP single sign-on:** someone signed in to the web app who connects an MCP client goes straight to the consent
  screen, without a second Netlify round-trip.
- **Team re-check:** with `NETLIFY_REQUIRED_TEAM`, the person's Netlify access token is kept encrypted (AES-256-GCM,
  with a key derived from the app's own data encryption key; never logged) and used to re-read
  `api.netlify.com/api/v1/accounts` at most once a day while a web session or MCP connection is in use. Someone no
  longer in the team ("You're no longer in the <team> Netlify team") loses their web sessions and MCP connections; a
  token Netlify rejects (revoked app access) ends that session or connection. If Netlify can't answer (5xx,
  timeouts), people stay signed in and the check is retried, for up to 7 days after the last good check; then they
  have to sign in again. API keys are not re-checked against the team: disable someone who leaves to revoke theirs.
- **API keys** keep working and no longer ask Identity; a key works while its owner's account is enabled and in an
  allowed domain.

**Existing Identity users carry over.** A person's first Netlify sign-in links to their existing account by its
verified email (Identity accounts first), with the same role, videos, comments and keys. From then on the link is by
their Netlify user id, so a later email change at Netlify doesn't split the account. If the person also has an
account that an earlier MCP OAuth sign-in created (an `oauth_netlify_…` id), it's merged into the Identity account in
one transaction: videos and versions, keys, connected apps, plans, comments, verdicts, notifications, media and edit
drafts move over, and the merged account is deleted (it stays disabled if either was). The admin People table shows
how each person signs in. Switching back to `AUTH_PROVIDER=identity` works too: accounts that came from Identity sign
in as before, while accounts created by Sign in with Netlify can only use MCP OAuth and their API keys.

## Developing

```sh
npm ci
npm test             # unit and integration tests (in-memory store and a real Postgres via PGlite)
npm run typecheck && npm run lint
npm run openapi:gen  # after changing routes; CI fails if openapi.json or the UI's types are stale
npm run db:generate  # after changing db/schema.ts
npx netlify dev      # local app (set ALLOW_NON_PRODUCTION=true to serve the API outside production)
```

The code is TypeScript throughout: Hono + zod-openapi API (`src/app.ts`), domain logic in `src/domain`, ports in
`src/deps.ts` with production adapters in `src/adapters` and fakes in `test/fakes.ts`, and a React + Mantine app
in `ui/`. The design and its reasoning are in [`PLAN.md`](PLAN.md); measurements behind the defaults are in
[`SPIKES.md`](SPIKES.md).

## License

MIT. Third-party pieces keep their own licences: IBM Plex fonts (SIL Open Font License 1.1, installed from npm
via `@fontsource`), Scalar API reference (MIT), Mantine (MIT), HyperFrames (see its package). The template ships no
Netlify brand assets; `context/` is neutral until you fill it in.
