# Deploy and run your own

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

**With your AI agent:** open the [setup prompt](https://netlify-video-agent.netlify.app/agent-setup/), copy it and
paste it into Claude Code, Codex, Cursor or another coding agent with a terminal. It follows the "From a clone" steps
below for you and asks you for the few things only you can do: the personal access token, linking the repo and your
admin account.

**With the button:** press **Deploy to Netlify** in the [README](../../README.md). It copies this repo to your GitHub and asks for the three settings
the agent needs to make videos. Don't have them ready? Leave them empty: the site still deploys, and you can add them
later under Project configuration > Environment variables (then redeploy). The `/setup` page lists anything missing.

| Variable                | What to enter                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `RUNNER_API_TOKEN`      | The personal access token.                                                               |
| `ALLOWED_EMAIL_DOMAINS` | Your company's email domains, comma-separated (`acme.com,acme.co.uk`), or `invite-only`. |
| `ADMIN_EMAILS`          | The first admins' email addresses, comma-separated.                                      |

Then follow the page Netlify shows after the deploy (it's [`USAGE.md`](../../USAGE.md)): enable **Identity**, set its
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
follow steps 1 and 3 of [`USAGE.md`](../../USAGE.md) for the registration mode and the first admin.

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

| Role         | Can                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| **Admin**    | Everything: people and roles, settings, usage, stopping runs, owner actions on any video                        |
| **Creator**  | Make, revise, remix and plan videos (spends credits); rename, publish, delete and make private their own videos |
| **Reviewer** | Watch videos and give feedback; never spends credits                                                            |
| **Viewer**   | Watch videos                                                                                                    |

API keys and the MCP server act with their owner's role. Disabling someone also revokes their API keys.

**Private videos** are hidden from everyone except their owner and admins: they don't appear in other people's
Library, search, API or MCP results. Private means hidden in the app among trusted colleagues, not confidential:
agent runs in this project can read the project's storage, so a Creator could have a run fetch another video's files.
A private video can still be published to a public link; publishing is a separate, explicit step.

## Sign in with Netlify for the web app

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

## Trust model, plainly

Agent runs in this project can read the project's environment variables, like any Netlify build. That includes
`RUNNER_API_TOKEN`. Only signed-in people from your allowed domains (or invited people) can start runs, and every
output is verified (hashes against the run's authenticated report, a real MP4 check) before it becomes a video.
Prompts are visible to your Netlify team in the project's Agent Runs page, so they carry no secret: a run proves which
attempt it is with a token derived from `VIDEO_AGENT_RUN_SECRET` (a secret environment variable `npm run setup`
creates), which it never writes down. Without it, each attempt's own token reaches the run through its run manifest
instead, and `/setup` warns.
Runs can also read the project's Blobs, so they can read uploaded media, including voice-over recordings.
A run renders offline, with one exception: when [Remotion](remotion.md) is
on, each Remotion render reports to remotion.pro which license key was used, the kind of event and whether it was
production or development.
Looks are instructions to the agent, like `context/`, so only people who can change the repo add them.

## Configuration

| Variable                                                 | Required?                                      | Default                                        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNNER_API_TOKEN`                                       | **Required**                                   | —                                              | Personal access token for starting and watching runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ALLOWED_EMAIL_DOMAINS`                                  | **Required**                                   | —                                              | Company domains, or `invite-only`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ADMIN_EMAILS`                                           | **Required**                                   | —                                              | First admins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `VIDEO_AGENT_RUN_SECRET`                                 | Recommended (`npm run setup` sets it)          | —                                              | At least 32 random characters. Mark it secret; scopes builds and functions. Runs derive their callback token from it, so none is in a prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MAX_ACTIVE_RUNS`                                        | Optional                                       | `3`                                            | Runs at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `AGENT`, `AGENT_MODEL`, `AGENT_EFFORT`                   | Optional                                       | runner default                                 | Which agent makes videos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SCOPED_AGENT_MODEL`, `SCOPED_AGENT_EFFORT`              | Optional                                       | the deployment's model                         | Model and effort for scoped revisions ([Redo a scene](redo-a-scene.md)), on revise and retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `AUTHORING_DEADLINE_MIN`                                 | Optional                                       | `22`                                           | Stop a run after this many minutes (the runner's ceiling is 25).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `QUEUE_TIMEOUT_MIN`                                      | Optional                                       | `60`                                           | Fail a video that waits in the queue longer than this.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RENDER_QUALITY`                                         | Optional                                       | `standard`                                     | HyperFrames render quality (`looks`, `standard`, `delivery`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ALLOWED_ORIGINS`                                        | Optional                                       | —                                              | Origins allowed to call the API from a browser with an API key (CORS).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `BRAND_ZIP_URL`                                          | Optional                                       | —                                              | A zip of your brand kit, used instead of committing it to `context/` ([how](../../context/README.md#keeping-your-brand-out-of-the-repo)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `AUTH_PROVIDER`                                          | Optional                                       | `identity`                                     | How people sign in to the web app: `identity` (Netlify Identity) or `netlify` ([Sign in with Netlify](#sign-in-with-netlify-for-the-web-app)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `NETLIFY_REQUIRED_TEAM`                                  | Optional                                       | —                                              | Netlify team slugs or ids (comma-separated). When set, every Netlify sign-in (web or MCP) must be a member of one; re-checked daily.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MCP_OAUTH_PROVIDER`                                     | Optional                                       | `netlify` with `AUTH_PROVIDER=netlify`, else — | `netlify` turns on OAuth for the MCP ([how](ai-tools.md#sign-in-with-netlify-oauth)); `off` turns it off. Off unless both credentials are set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `NETLIFY_OAUTH_CLIENT_ID`, `NETLIFY_OAUTH_CLIENT_SECRET` | Optional (needed with `AUTH_PROVIDER=netlify`) | —                                              | The Netlify OAuth application for Sign in with Netlify (web and MCP share it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MCP_OAUTH_ALLOWED_EMAIL_DOMAINS`                        | Optional                                       | `ALLOWED_EMAIL_DOMAINS`                        | Email domains that may connect over OAuth. With neither set to domains (`invite-only`), only existing accounts can.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MCP_OAUTH_CIMD_HOSTS`                                   | Optional                                       | `claude.ai,claude.com`                         | Hosts whose https client ids (Client ID Metadata Documents) are fetched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `OPENVERSE_CLIENT_ID`, `OPENVERSE_CLIENT_SECRET`         | Optional                                       | —                                              | A registered Openverse app for Find music and runs' music (higher rate limits). Without them, searches are anonymous ([Music](music.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ELEVENLABS_API_KEY`                                     | Optional                                       | —                                              | ElevenLabs voices (with word timings) for voice-overs; the voice picker then offers them and they become the default. Without it, voice-overs use Kokoro, which is built in. Scope it to builds (agent runs read it) and functions (the voice picker lists your account's voices, which needs the key's Voices: read permission, and speaks a short sample of each the first time someone plays it; **Other…** searches ElevenLabs' voice library and adds a voice to your account, which needs Voices: write and takes a voice slot; without the key in functions it lists ElevenLabs' default voices). If you mark it secret, also give it a value in the `dev-server` context: that's the one agent runs read. |
| `ELEVENLABS_VOICE_ID`                                    | Optional                                       | Roger                                          | The ElevenLabs voice used when a video doesn't choose one (scopes: builds and functions). Setting it also tells the app ElevenLabs is on when functions can't read the key.. Free ElevenLabs plans can only use ElevenLabs' default voices through the API.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ENGINES`                                                | Optional                                       | `hyperframes`                                  | Engines this deployment may offer. Add `remotion` only with its license ([Remotion](remotion.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `VIDEO_AGENT_REMOTION_KEY`                               | Optional (for a Company License)               | —                                              | Your Remotion key (`rm_sec_…`). Secret; not `REMOTION_`-prefixed, so Remotion never hands it to video code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `VIDEO_AGENT_REMOTION_DEVELOPMENT`                       | Optional (test deployments only)               | —                                              | `1` marks this deployment's Remotion renders as development ones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
