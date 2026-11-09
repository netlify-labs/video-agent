# Remix a video

**Remix** makes a new video, owned by you, that starts from another video's finished composition and changes it as
you say. There's no mode to pick: "keep everything, but call the product Orbitly" changes just that, and "same format,
about our payments API" rewrites the script and on-screen text and keeps the style. Remix is on a video's page, in a
Library tile's **⋯** menu, on its share page (only for signed-in people who can create) and under **New video → Start
from an existing video**.

- **What carries over:** the composition, and the source's shape, length, sound, AI voice-over settings, language and
  library media, each of which you can change before you start. The run applies today's brand from `context/`.
- **What doesn't:** recorded narration is removed from the copy, so the remix has no recorded voice until you record
  one. Comments, verdicts, publications and the source's webhook stay with the original.
- **The remix is its own copy.** Deleting or revising the original doesn't change it. It shows "Remix of _title_ vN",
  linked to the source when you can still see it.
- **Private stays private.** Only people who can see a video can remix it, so a private video can be remixed by its
  owner and admins, and its remix starts private. An admin who remixes someone's private video gets a copy of its
  content and prompt history; the owner isn't notified.
- **Credits:** a remix is an agent run, so it spends credits like any other.
- **Admin switch:** **People can remix videos** on the Admin page turns it off for everyone, without a redeploy.
  Remix disappears from the app, and the API, plans and MCP refuse (`409 remix_disabled`). Remixes already queued
  still run.

From scripts, `POST /api/v1/videos/{id}/remix` with `{"prompt": "…"}` and, optionally, `fromVersion` (default: the
latest ready version), `aspect`, `durationSec`, `language`, `sound`, `voiceover`, `mediaIds` (replaces the source's
set), `planId` and `webhookUrl`. It takes an `Idempotency-Key` header and returns 202 with the new video. From AI
tools, it's the `remix_video` MCP tool.
