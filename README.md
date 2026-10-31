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

`npm run setup` creates (or reuses) the project, asks for the three values above, saves them, enables Identity
and, once the project is connected to your GitHub repo, starts a production build and runs the setup checks. The
first time, it stops and tells you where to link the repo; run it again with the `--site` it prints. Then
follow steps 1 and 3 of [`USAGE.md`](USAGE.md) for the registration mode and the first admin.

Either way, the database (Netlify Database) is created and its tables are migrated automatically by the
production build from Git (the migrations are in `netlify/database/migrations/`). There's nothing to run by hand.

## Who can sign in

Sign-in uses [Netlify Identity](https://docs.netlify.com/manage/security/secure-access-to-sites/identity/overview/).
`ALLOWED_EMAIL_DOMAINS` picks one of two modes:

- **Company domains** (`acme.com`): anyone with an `@acme.com` address can create an account and must confirm their email. Keep Identity's **autoconfirm off**, or people could claim addresses they don't own. Other domains are refused at sign-up and by the API.
- **`invite-only`**: set Identity registration to **Invite only** and invite people from the Identity tab. Nobody else can sign up.

`ADMIN_EMAILS` become admins on their first sign-in. Admins can make others admins, disable people (which also revokes their API keys), stop runs and see usage on the Admin page. Everyone signed in can see and revise every video; only a video's owner or an admin can rename, publish, unpublish or delete it.

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

| Variable                               | Default        | Meaning                                                                                                                             |
| -------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `RUNNER_API_TOKEN`                     | —              | Personal access token for starting and watching runs.                                                                               |
| `ALLOWED_EMAIL_DOMAINS`                | —              | Company domains, or `invite-only`.                                                                                                  |
| `ADMIN_EMAILS`                         | —              | First admins.                                                                                                                       |
| `MAX_ACTIVE_RUNS`                      | `3`            | Runs at once.                                                                                                                       |
| `AGENT`, `AGENT_MODEL`, `AGENT_EFFORT` | runner default | Which agent makes videos.                                                                                                           |
| `AUTHORING_DEADLINE_MIN`               | `22`           | Stop a run after this many minutes (the runner's ceiling is 25).                                                                    |
| `QUEUE_TIMEOUT_MIN`                    | `60`           | Fail a video that waits in the queue longer than this.                                                                              |
| `RENDER_QUALITY`                       | `standard`     | HyperFrames render quality (`looks`, `standard`, `delivery`).                                                                       |
| `ALLOWED_ORIGINS`                      | —              | Origins allowed to call the API from a browser with an API key (CORS).                                                              |
| `BRAND_ZIP_URL`                        | —              | A zip of your brand kit, used instead of committing it to `context/` ([how](context/README.md#keeping-your-brand-out-of-the-repo)). |

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
`create_video`, `get_video`, `list_videos`, `revise_video`, `publish_video`, `unpublish_video`, `cancel_video`.

- Server URL: `https://<your-site>/mcp` (Streamable HTTP). Authenticate with an API key: `Authorization: Bearer nva_…`.
- Claude Code: `claude mcp add --transport http video-agent https://<your-site>/mcp --header "Authorization: Bearer nva_…"`
- Cursor and others (`mcp.json`): `{ "mcpServers": { "video-agent": { "url": "https://<your-site>/mcp", "headers": { "Authorization": "Bearer nva_…" } } } }`
- Stdio-only clients: `npx -y mcp-remote https://<your-site>/mcp --header "Authorization: Bearer nva_…"`

The web app's **API docs** page has the REST reference and these instructions with your site's URL filled in.

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
