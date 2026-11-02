# Connecting to the video agent

MCP server: `{{SITE_URL}}/mcp` (Streamable HTTP, stateless).

## Authentication

- **API key.** Create one at {{SITE_URL}}/keys. Keys start with `nva_` and are shown once. Send it as
  `Authorization: Bearer nva_…`. Keep it in an environment variable (the examples use `VIDEO_AGENT_API_KEY`), never
  in a prompt or a file you commit.
- **Sign in with Netlify (OAuth).** When the deployment has it on, OAuth-capable clients (Claude Code, Claude and
  ChatGPT connectors) can add the URL with no header: the client opens a browser, you sign in with Netlify and approve
  it, and it acts as you. If the server answers 401 with no sign-in prompt, OAuth is off: use a key. Connected apps
  are listed, and can be revoked, on the API keys page.

Either way the connection acts as the person, with their role.

## Clients

Claude Code:

```sh
claude mcp add --transport http video-agent {{SITE_URL}}/mcp \
  --header "Authorization: Bearer $VIDEO_AGENT_API_KEY"
# With Sign in with Netlify: add it without --header, then run /mcp in Claude Code to sign in.
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.video-agent]
url = "{{SITE_URL}}/mcp"
bearer_token_env_var = "VIDEO_AGENT_API_KEY"
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "video-agent": {
      "url": "{{SITE_URL}}/mcp",
      "headers": { "Authorization": "Bearer ${env:VIDEO_AGENT_API_KEY}" }
    }
  }
}
```

Gemini CLI (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "video-agent": {
      "httpUrl": "{{SITE_URL}}/mcp",
      "headers": { "Authorization": "Bearer $VIDEO_AGENT_API_KEY" }
    }
  }
}
```

Clients that only speak stdio can use a bridge:

```sh
npx -y mcp-remote {{SITE_URL}}/mcp --header "Authorization: Bearer $VIDEO_AGENT_API_KEY"
```

## Uploading media (screenshots, logos, clips)

The MCP tools read the media library (`list_media`) and import Openverse music (`import_music`), but don't upload
files. With an API key, upload a file of up to 4 MB through the REST API, then pass the returned `id` in `media_ids`:

```sh
curl -fsS -X POST "{{SITE_URL}}/api/v1/media?filename=checkout.png&caption=New%20checkout%20page" \
  -H "Authorization: Bearer $VIDEO_AGENT_API_KEY" \
  -H "content-type: application/octet-stream" \
  --data-binary @checkout.png
```

The item is checked before it can be used: `GET {{SITE_URL}}/api/v1/media/<id>` until `status` is `ready` (a
`rejected` item says why in `rejectReason`). A caption tells the video agent what the item is. Bigger files use upload
sessions; the full REST reference is at {{SITE_URL}}/docs. OAuth connections are for the MCP only, so uploading needs
a key.
