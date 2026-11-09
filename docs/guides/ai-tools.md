# AI tools: MCP, WebMCP and the agent skill

## Use it from AI tools (MCP)

Agents with a shell (Claude Code, Codex) can also use the CLI: one `video-agent create … --wait --json` instead of a
polling loop. The `netlify-video` skill's `references/cli.md` tells them how.

The same video tasks are MCP tools, so people can ask Claude, Cursor or any MCP client for a video:
`create_video`, `get_video`, `show_video`, `list_videos`, `revise_video`, `remix_video`, `publish_video`, `unpublish_video`, `cancel_video`,
`set_verdict`, `list_comments`, `add_comment`, `list_media`, `search_music`, `import_music` and `get_music_job` (CC0
and CC BY music from Openverse),
and, when AI Gateway is available, `plan_video` and `plan_brief` (ask a few questions first, then create with the plan). Each key's tool list matches its owner's role: Reviewers see the read and review tools, Viewers read only.

Recorded voice-over has three tools: `get_narration` reads a version's narration (or your draft's),
`add_narration` places an uploaded recording on your draft by media id (no URLs; it takes the narration lock), and
`render_with_narration` renders it as the next version, over the kept visuals or (`fit_to_narration`, an authoring
run) with the scenes fitted to it. `get_video` reports the video's spoken `language`, and `add_narration` can set it. The skill's
`references/narration.md` walks agents through uploading and rendering.

In clients that show [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (Claude, for one), `create_video`,
`revise_video` and `show_video` also show a **video card** in the chat. It follows the run with `get_video` and plays
the video when it's ready, with Download, Open in Video Agent, and full screen or picture-in-picture where the
client offers them. Other clients get the same JSON, and every result in progress tells the agent to keep checking
until the video is done. The card is `app/web/src/mcp-app/video-card.ts`, bundled into `app/server/generated/video-card.ts` by
the build.

- Server URL: `https://<your-site>/mcp` (Streamable HTTP). Authenticate with an API key: `Authorization: Bearer nva_…`,
  or, when it's on, [Sign in with Netlify](#sign-in-with-netlify-oauth).
- Claude Code: `claude mcp add --transport http video-agent https://<your-site>/mcp --header "Authorization: Bearer nva_…"`
- Cursor and others (`mcp.json`): `{ "mcpServers": { "video-agent": { "url": "https://<your-site>/mcp", "headers": { "Authorization": "Bearer nva_…" } } } }`
- Stdio-only clients: `npx -y mcp-remote https://<your-site>/mcp --header "Authorization: Bearer nva_…"`

The web app's **API docs → MCP for AI tools** page (`/docs/mcp`) has these instructions with your site's URL filled in,
and the tool list from [`app/server/mcp-catalog.ts`](../../app/server/mcp-catalog.ts), which a test keeps in step with the server.

## WebMCP: AI agents in the browser

The web app also offers its pages to AI agents running in the browser through
[WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`). Each page registers only its own
tools while it's open: the library's `list_videos` and `open_video`, New video's `fill_video_form` and `create_video`,
the video page's `get_video`, `control_player`, `add_comment`, `revise_video`, `restyle_video`, `remix_video`,
`publish_video` and `unpublish_video`, and the editor's `list_scenes`, `edit_text`, `set_scene_duration`,
`reorder_scenes`, `delete_scene`, `seek`, `select_clip`, `undo`, `redo` and `render_edit`, plus `get_page` and
`navigate` everywhere. They work in the person's signed-in tab, through the same controls and requests as their clicks.
Anything that spends credits, publishes or deletes shows an in-app confirm the person must click (WebMCP has no consent
step of its own yet). Tools that return people's words are marked `untrustedContentHint`.

To try it: WebMCP is an origin trial from Chrome 149. Open `chrome://flags/#enable-webmcp-testing`, enable it and
relaunch, then sign in to your site and run `await document.modelContext.getTools()` in the console, or use a browser
agent that supports WebMCP. **API docs → WebMCP in the browser** (`/docs/webmcp`) lists every tool. An admin can turn
WebMCP off on the Admin page (on by default); browsers without it see nothing.

## Agent skills and MCP prompts

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

The **API docs → Agent skills** page (`/docs/skills`) has the command for each agent. The same recipes are MCP prompts (`pr_video`, `changelog_video`,
`social_cut`, `localize_video`, `review_video`) for clients without skills, filtered by role like the tools.

## Sign in with Netlify (OAuth)

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
[Sign in with Netlify for the web app](deploy.md#sign-in-with-netlify-for-the-web-app)). With `NETLIFY_REQUIRED_TEAM` set, MCP sign-ins must be in that team too, whichever `AUTH_PROVIDER` is used.
