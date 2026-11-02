---
name: netlify-video
description: Make, revise, review and publish short videos with the video agent at {{SITE_URL}} through its MCP tools. Use when someone asks for a demo, launch, changelog or social video, a video from a pull request or release notes, a vertical cut of an existing video, captions in other languages, or wants feedback on a video.
---

# Netlify video agent

The video agent at {{SITE_URL}} turns a prompt into a short MP4. Each video is made by an AI agent with HyperFrames
(HTML, CSS and GSAP rendered to video) and takes 3 to 8 minutes. Videos are silent, with captions, and the team's
brand (colors, logo, fonts) is applied automatically. Every video keeps its versions: a revision makes the next
version and changes only what you describe.

You drive it through MCP tools. If the tools below aren't available, connect first: see
[references/connect.md](references/connect.md).

## Connect (short version)

- MCP server: `{{SITE_URL}}/mcp` (Streamable HTTP).
- Auth: an API key from {{SITE_URL}}/keys sent as `Authorization: Bearer nva_…`, or, when the deployment has it on,
  **Sign in with Netlify** (OAuth): add the URL alone and the client opens a browser to sign in.
- Claude Code: `claude mcp add --transport http video-agent {{SITE_URL}}/mcp --header "Authorization: Bearer $VIDEO_AGENT_API_KEY"`

Keys act as their owner with their role. Creators can make videos; Reviewers can comment and approve; Viewers can
only watch. The tool list shows only what your role can do.

## The flow

1. **Plan (optional).** When `plan_video` is listed and the request is vague, call it with the request as `prompt`.
   If it returns questions, ask the person (each can be skipped), then call `plan_brief` with `plan_id` and their
   `answers` (`question_id` plus `choice_ids`, `other` text, or `skipped`). Show the brief. Skip planning when the
   request is already specific.
2. **Create.** `create_video` with `prompt` (quote exact on-screen text), and optionally `aspect` (16:9, 9:16, 1:1,
   4:5), `duration_sec`, `title`, `plan_id`, `media_ids` and an `idempotency_key`. It returns at once with status
   "queued" and a `video_id`.
3. **Follow.** `get_video` with `video_id` and `wait_seconds: 8`, about once a minute, until the status is "ready" or
   "failed". While it runs, the result carries `progress` (stage and step); tell the person what the agent is doing
   rather than polling silently.
4. **Deliver.** A ready video has signed download URLs (MP4, poster, GIF, captions; valid 1 hour) and a `web_url` in
   the app. For a permanent public link, `publish_video` returns a share page that unfurls in Slack, the MP4, a GIF and
   an embed snippet. `unpublish_video` takes it down.
5. **Change.** `revise_video` with `video_id` and `change` (only what should change). Pass `from_version` to branch
   from an earlier ready version, `comment_ids` to fold in feedback, and `media_ids` to add library items.

Other tools: `list_videos` (find a video by words in its prompt or title, `mine` for your own), `cancel_video` (stop
the version in progress), `list_media` (the team's logos, screenshots, clips, fonts and music), `search_music` and
`import_music` (find CC0 or CC BY music on Openverse and add it to the library; `get_music_job` finishes a slow one),
`list_comments`, `add_comment` and `set_verdict` (review; see the recipes).

## Etiquette

- **Ask before spending a run.** Each create or revise starts an agent run that costs credits. Confirm the prompt, the
  aspect and the length with the person first, unless they already asked you to go ahead.
- **One at a time.** Only one version of a video can be in progress. Don't call `create_video` again for the same
  request while it runs; poll with `get_video`. Use an `idempotency_key` when a retry might double-submit.
- **Revise, don't recreate.** Small fixes ("bigger logo", "end card says Start free") are a `revise_video`. A new
  video is for a new idea, or a different aspect (aspect is fixed per video).
- **Reuse media.** Check `list_media` for the logo, product screenshots and fonts, and pass their ids as `media_ids`
  instead of describing them. To add a screenshot, upload it (see [references/connect.md](references/connect.md)).
- **Music without a licence worry.** When the library has no fitting track, `search_music` finds CC0 and CC BY music
  (never NC, ND or SA), `import_music` adds the pick, and its media id goes in `media_ids` with `sound` "music". CC BY
  tracks are credited on the video page, the share page and the embed automatically. Openverse is sometimes slow (up
  to a minute): then either tool answers `{"status": "pending", "job_id": …}`. Call `get_music_job` with that `job_id`
  and `wait_seconds: 8` until `status` is "done" (it returns the same result), instead of searching again.
- **Share links, not files.** Give the person `web_url` or the published share page. Download URLs expire in an hour.
- **Never paste keys into prompts.** Keep the API key in an environment variable or the client's secret store. Never
  put it in a video prompt, a comment, a commit or a chat message.

## Recipes

Step-by-step versions are in [references/recipes.md](references/recipes.md):

- **Pull request → demo or launch video.** Read the PR's title, description, diff and screenshots; write a brief;
  upload the screenshots as media; create.
- **Release notes or changelog → changelog video.** Pick the three to five changes that matter, one beat each.
- **Long video → 15-second vertical cut.** A new 9:16 video from the long one's summary and media.
- **Localise** captions and on-screen text into other languages, one revision per language.
- **Review loop.** Read comments, add your own, approve or request changes, and revise with the feedback.

The MCP server also offers these recipes as prompts (`prompts/list`), so clients without skills get them too.
