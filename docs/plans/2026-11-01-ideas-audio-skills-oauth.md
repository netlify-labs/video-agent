# Ideas: sound, voice-over, agent skills and an optional MCP OAuth path

Status: ideas only (idea-wizard phases 1–3). No beads yet; pick from the top 5 and next 10 before planning.

## What's true today (grounding)

- Every run is told `Format: …, 30 fps, silent.` (src/domain/prompt.ts). The media library takes images, SVG, MP4
  and fonts, not audio. Library-hover clips and embeds are muted.
- HyperFrames already does audio: separate `<audio id>` elements for music and voice, `data-has-audio` on clips,
  `hyperframes audio` (place a clip), `normalize-audio` (LUFS matching), a mix with typed failure diagnostics, and its
  `media-use` skill: music (HeyGen catalog, or local MusicGen), voice-over (HeyGen voices or `npx hyperframes tts`,
  Kokoro on device with Python 3.10+), CC-BY sound effects, transcripts and captions. When `HEYGEN_API_BASE` is set,
  the host pays and the agent doesn't sign in.
- The MCP (`/mcp`) authenticates `Authorization: Bearer nva_…` API keys only (src/domain/auth.ts
  `principalFromRequest`), and has no OAuth discovery, so OAuth-only clients (claude.ai web connectors, ChatGPT,
  day.ai) can't connect without someone pasting a key.
- Prior art for OAuth: an internal MCP gateway of ours is a full OAuth 2.1 authorization server in front of
  Netlify OAuth: RFC 8414/9728 metadata, DCR (`oauth-registration`), CIMD client ids (`cimd.ts`, host allowlist as an
  SSRF guard), PKCE codes, opaque hashed tokens with 30-day sessions (`token-service.ts`), and an employee check
  (a company email and an approved account). Lessons it paid for: loopback redirect URIs
  must match on any port (RFC 8252); non-Claude clients need their own public client records; tokens must be
  bound to the `resource`.
- Prior art for serving skills: an internal skills service serves the repo's skills as zips at an unlisted URL with
  deterministic (UTC-stamped) zip entries.

## The 30 considered

Sound: (1) audio media kind in the library, (2) a Sound choice per video (silent / music / music + effects),
(3) script-first voice-over with TTS, (4) narration-timed beats and captions from word timings, (5) loudness
targets and ducking, (6) audio in the editor (swap track, volume, mute, re-voice a line), (7) word-highlight captions
from the voice track, (8) language variants (translated captions and voice), (9) a brand sound kit in context/,
(10) sound effects on visible actions with a credits file, (11) unmute toggle on the Library hover and share page,
(12) presenter/avatar via HeyGen.
Skills: (13) an installable agent skill for Claude Code/Codex/etc. that drives the video MCP, (14) recipe packs
(PR → demo video, weekly changelog, social cut, localise), (15) the same recipes as MCP `prompts`, (16) admin-authored
house recipes and templates the planner offers, (17) website URL → video (captured screens), (18) a GitHub Action that
makes a video on release and comments on the PR.
Auth: (19) optional OAuth 2.1 for the MCP alongside API keys, (20) scopes on OAuth grants, (21) a Connected apps page
to see and revoke grants, (22) any OIDC provider (Google Workspace, Okta) as the upstream.
Other: (23) style templates gallery, (24) scheduled/recurring videos, (25) share-page analytics, (26) chapters and
poster choice, (27) aspect variants (vertical/square cut of a 16:9 version), (28) Slack delivery with the hover clip,
(29) cost estimate before a run, (30) regenerate one beat only.

## Top 5, best first

### 1. Optional OAuth for the MCP, API keys untouched

**What.** When OAuth env vars are set, `/mcp` also accepts OAuth access tokens and advertises itself as an OAuth
protected resource; when they aren't, nothing changes. A generic upstream-identity interface
(`authorizeUrl(state, redirectUri)`, `exchange(code) → { subject, email, emailVerified }`) with one implementation,
Netlify OAuth, plus an email-domain rule (reuse `ALLOWED_EMAIL_DOMAINS`; ours: netlify.com).

**How it would work.**

- Keys first, always: `principalFromRequest` keeps parsing `nva_…` keys exactly as now; any other bearer is tried as an
  OAuth token only when OAuth is configured. 401s add `WWW-Authenticate: Bearer resource_metadata=…` only when
  enabled, so API-key clients and docs see no difference.
- Endpoints (only mounted when enabled): `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`, `/oauth/register` (DCR, public clients, PKCE S256 only), CIMD client ids
  with a host allowlist,
  `/oauth/authorize` → Netlify `/authorize` → `/oauth/callback` (domain check) → code → `/oauth/token`
  (authorization_code + refresh_token). Tokens are opaque, stored hashed in Netlify DB, audience-bound to this site's
  `/mcp`, short access (1 h) and rotating refresh (30 days), revocable.
- Identity mapping: the verified email maps to the existing user row (same roles, privacy and ownership); a first-time
  email that passes the domain rule gets a row with the default role, like Identity sign-up does. The Principal gets
  `kind: 'oauth'` so audit logs and the Keys page can tell them apart.
- Port the gateway's hard-won details: any-port loopback redirects, exact redirect matching otherwise, `resource`
  required and checked, state/PKCE binding, size and time bounds on upstream calls, no secrets in logs.

**Why it's worth it.** It's the only way claude.ai web connectors, ChatGPT and other OAuth-only MCP clients can use the
video agent without pasting a long-lived key, and it ties MCP access to the person's Netlify identity (off-boarding
works automatically). Being opt-in by env var keeps the open-source template simple for everyone else.
**Confidence: high** — the gateway already proved the flow with the same clients; this is a smaller, single-resource
version of it.

### 2. Sound, starting with music: an audio media kind and a Sound choice per video

**What.** Let the library hold audio (MP3, M4A/AAC, WAV, OGG; sniffed, duration and size capped, loudness measured on
upload) and add a Sound option on create/revise/plan: Silent (today's default), Music, Music + sound effects. The
prompt stops saying "silent" unless Silent is chosen, names the picked track as fenced data, and asks for a mix at a
web loudness target (about −14 LUFS) with the music ducked under any voice.
**Music sources, in order:** a picked library track; the brand's music in context/ (new: a sonic logo and preferred
genre/tempo); an admin-curated set of royalty-free tracks; otherwise no music (local MusicGen is too heavy for a
runner, and HeyGen's catalog is paid and opt-in via `HEYGEN_API_BASE`).
**Also:** muted hover clips stay muted; the player and share page get sound; captions are unaffected.
**Why.** Silent marketing video is the single biggest quality gap versus hand-made videos, HyperFrames already knows
how to place and mix audio, and the library/version-media plumbing (snapshots, hydration, hashes) already exists, so
an audio kind is mostly classification + limits + prompt changes. **Confidence: high** on value, medium on licensing:
only user-uploaded or clearly licensed tracks, never scraped music.

### 3. Script-first voice-over with word-timed captions

**What.** A Voice-over option: the planner (or the person) writes a narration script per beat; a TTS step turns it into
audio with word timestamps; beats are timed to the narration and captions come from the words (exact sync, optional
word highlight).
**Providers behind one interface:** Kokoro on the runner via `npx hyperframes tts` (free, on device; needs Python 3.10+
and `kokoro-onnx`, so add it to netlify-agent-kit setup if the install cost is acceptable); OpenAI TTS through the
Netlify AI Gateway when available (spike: confirm the Gateway proxies audio endpoints and what it costs); ElevenLabs or
HeyGen voices when their keys are set. Voice and speed are choices; a brand voice can live in context/.
**Why.** Voice-over turns a motion graphic into an explainer, word timings fix caption drift for free, and a
script-first flow is exactly what "Plan it first" already produces (the brief's beats become the script).
**Confidence: medium-high** — Kokoro quality is good for English; the open question is runner install time and the
AI Gateway audio path (spike both before committing).

### 4. Installable agent skills (and the same recipes as MCP prompts)

**What.** A `netlify-video` skill people install into Claude Code, Codex, Cursor or Gemini CLI: how to connect the MCP
(API key or OAuth), the tool flow (plan → questions → brief → create → poll → publish), etiquette (ask before
spending, use media_ids, share links), and recipes: PR → demo video (read the diff and screenshots), release notes →
changelog video, long video → 15 s social cut, localise into N languages. Serve it from the site as a deterministic
zip with install commands on the API docs page (that internal skills service is the pattern), and expose the recipes as
MCP `prompts` so clients without skills still get them.
**Why.** The MCP is powerful but blank; skills teach agents the good path and make "make a launch video for this PR"
a one-liner. Shipping it from the deployment means every fork serves its own, pointing at its own URL.
**Confidence: high** — low cost, and the docs page already explains MCP setup.

### 5. Audio in the editor: swap the track, set levels, re-voice a line

**What.** Extend editing contract v1 with audio slots (`data-va-audio="music|voice"`, volume, fades) and voice lines
tied to beats. The editor gets a track picker (audio library), volume and mute, and editable narration text that
re-runs TTS for just that line. Renders stay render-unchanged (no agent rewrite), so small audio fixes cost about
35 credits instead of a revision.
**Why.** The most common feedback on narrated videos is "change that word" and "music's too loud"; today both need a
full revision. **Confidence: medium** — depends on 2 and 3 landing first, and on TTS being callable outside a run
(server-side or a small render-unchanged step).
**Status:** built. Track swap, volume and mute shipped first; re-voicing a line happens in the edit's render run
(`scripts/voice.ts revoice`), because neither Kokoro nor the AI Gateway can speak inside a Function. A longer line
grows its beat only when it no longer fits; render-job checks that only the re-voiced files changed
(`src/lib/revoice.ts`).

## Next 10, and why

6. **Language variants.** Translate captions and voice per language into sibling versions (same visuals, swapped
   text and audio), publishable separately. High value for global launches; builds on 3 and render-unchanged.
7. **Brand sound kit in context/.** Sonic logo, music genre/tempo, voice, loudness target, next to the brand guide, so
   every video sounds on-brand without repeating it in prompts. Cheap once 2 exists.
8. **House recipes and templates (admin-authored).** Admins save proven prompts/briefs/styles ("Launch, 30 s,
   vertical") that the planner offers and MCP exposes as prompts. Turns one person's good video into a team
   standard.
9. **Connected apps and scopes.** A page listing OAuth grants (client, last used, scopes) with revoke, next to API
   keys; scopes map to roles (read-only clients can't spend). Completes idea 1 for admins and security review.
10. **Any OIDC upstream.** Generic OIDC (Google Workspace, Okta, Entra) as a second implementation of the upstream
    interface, so open-source deployments outside Netlify get OAuth MCP too. The interface in 1 makes it small.
11. **Sound effects with credits.** Use the CC-BY effects library on visible actions (clicks, whooshes) and write a
    credits file the share page shows. Polishes 2 with little risk.
12. **Aspect variants.** One click to make a vertical or square cut of a finished 16:9 version (re-layout, same
    script and audio). Social teams always need both.
13. **Regenerate one beat.** Revise only beat N (agent restricted to that scene), keeping the rest frozen — faster,
    cheaper, less drift than a full revision.
14. **Scheduled videos.** "Every Friday, a changelog video from merged PRs" via a scheduled function calling the same
    create path (with a spend cap and a review step before publish).
15. **Share-page analytics.** Views, play rate and completion per published version (first-party, no third-party
    trackers), to learn which videos work.

## Open questions before planning

- Runner: is adding Python + Kokoro (and ffmpeg loudness tools) to netlify-agent-kit setup acceptable in time and
  size? Spike S9.
- AI Gateway: does it proxy OpenAI audio (TTS) and at what credit cost? Spike S10.
- Music licensing policy for the curated set (CC0 only? a licensed pack?).
- OAuth: should first-time OAuth users get an account automatically (domain rule) or must they sign in to the web app
  once first? Which client registration paths to enable by default (DCR, CIMD, both)?
