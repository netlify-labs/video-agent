---
name: video-agent-cli
description: Make, revise, publish and download videos from a terminal with the video-agent CLI (npm package netlify-video-agent), against the video agent at {{SITE_URL}} or on this machine with no deployment. Use when you have a shell and someone asks for a video, a demo from a pull request or a screen recording, a changelog video, or wants video work scripted in CI.
---

# The video-agent CLI

`video-agent` talks to the video agent at {{SITE_URL}}. One command makes a video, waits for it and downloads it,
so you don't need a polling loop. Add `--json` and stdout is exactly one JSON object.

Every command, flag and exit code is in [references/commands.md](references/commands.md). For what to make and how
to ask for it (planning, looks, revising, recipes), use the `create-video` skill.

## Set up

```sh
npm i -g netlify-video-agent            # or prefix each command with: npx -y netlify-video-agent
video-agent login --url {{SITE_URL}}    # approve this terminal in the browser; the key is saved for you
video-agent whoami
```

In CI, set `VIDEO_AGENT_URL={{SITE_URL}}` and `VIDEO_AGENT_KEY=nva_…` instead of logging in. Never put a key on
the command line or in a prompt.

## Make a video

```sh
video-agent looks                                              # the styles this deployment offers
video-agent create "A 20-second launch video for our webhooks feature" --aspect 16:9 --look kinetic \
  --wait --out ./webhooks --json
```

`--wait` follows the run (3 to 8 minutes) with progress on stderr. `--out` downloads the MP4, poster and captions.
Pass screenshots or logos with `--media ./shot.png`; they're uploaded first.

## Change it

```sh
video-agent revise vid_… "Make the end card orange" --wait     # a new version; only what you describe changes
video-agent scenes vid_…                                       # scene ids, labels and times
video-agent redo vid_… --scene intro "Shorter title" --wait    # redo some scenes, keep the rest exactly
video-agent remix vid_… "Same format, about edge functions"    # a new video that starts from this one
video-agent publish vid_… --json                               # share page, MP4 link and embed snippet
```

`vid_…` can also be the video's web address or a share link.

## From a pull request or a release

```sh
video-agent brief pr https://github.com/acme/web/pull/123 | video-agent create --prompt-file - --wait
```

`brief release` and `brief changelog` work the same way for release notes.

## Screen recordings

```sh
video-agent record https://app.example.com --out ./take1 --hide-text "Acme Labs"
video-agent create "A demo of adding a webhook" --recording ./take1 --wait
```

`record` drives a browser and saves the recording with exact clicks, so the demo's zoom and cursor follow them.

## No deployment

```sh
video-agent doctor
video-agent local "A 20-second launch video for our webhooks feature" --aspect 16:9
video-agent local revise ./videos/webhooks-launch "Make the end card orange"
```

`local` makes the video on this machine with your own coding agent, inside a sandbox. It costs no credits, and a
`./context/` folder, if there is one, is the brand.

## Etiquette

- **Ask before spending a run.** Every `create`, `revise`, `redo` and `remix` starts an agent run that costs credits.
  Confirm the prompt, shape and length first unless the person already said to go ahead.
- **One at a time.** Only one version of a video runs at once. Use `video-agent wait vid_…` to follow one you started
  earlier instead of starting another.
- **Read errors from the exit code.** The table in [references/commands.md](references/commands.md) says what each
  one means; with `--json`, the error object has a `code` and a `requestId`.
