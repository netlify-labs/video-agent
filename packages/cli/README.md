# netlify-video-agent

[![npm](https://img.shields.io/npm/v/netlify-video-agent)](https://www.npmjs.com/package/netlify-video-agent)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**`video-agent` turns a prompt into a finished MP4**, with captions, a poster and a GIF. It runs on your machine
with your own coding agent, or against a [Video Agent](https://github.com/netlify-labs/video-agent) deployment your
team shares.

```sh
npx -y netlify-video-agent@1 local "A 20-second launch video for our webhooks feature"
```

## Why use it

**The problem.** A short product video takes a motion designer and a day, so most launches, pull requests and
changelogs ship without one.

**The solution.** Describe the video in a sentence. A coding agent writes it as HTML and CSS, checks it and renders
it. To change it, say what to change, and you get the next version.

| What you get               | How                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| No server to start         | `video-agent local` uses your own Claude Code, inside a sandbox                          |
| Videos in your brand       | Put your brand guide in `./context/`, or pick one of the 14 bundled Looks                |
| Changes in plain words     | `local revise ./videos/launch "Make the end card orange"` makes `v2` and keeps `v1`      |
| Demos from a real app      | `record` captures a web app with a pointer trace; `local demo` turns it into a video     |
| The same tool for the team | `login` once, then `create`, `revise` and `publish` against your deployment              |
| Built for scripts and CI   | `--json` on every command, [exit codes](#exit-codes) you can branch on, idempotency keys |

## Quick example

```sh
npm install -g netlify-video-agent

# Check that this machine has what local mode needs
video-agent doctor

# Make a video (it takes a few minutes)
video-agent local "A 20-second launch video for our webhooks feature" --aspect 16:9

# Change it: this makes v2 and keeps v1
video-agent local revise ./videos/webhooks-launch "Make the end card orange"

# Redo one scene and leave the rest as it is
video-agent local revise ./videos/webhooks-launch --scene demo "Show the preview URL"

# Add music, a voice-over and your own screenshot
video-agent local "A product teaser" --voice --sound music --media ./shot.png:"The new dashboard"
```

Each version lands in `./videos/<name>/vN/`:

```text
videos/webhooks-launch/v1/
├── video.mp4
├── poster.jpg
├── preview.gif
├── captions.vtt
└── source.tar.gz    the HTML it was rendered from
```

## Two ways to run it

|                    | On your machine (`local`)            | With a deployment (`create`)                        |
| ------------------ | ------------------------------------ | --------------------------------------------------- |
| Needs              | Node 22, Claude Code, macOS or Linux | Node 22 and a deployed Video Agent site             |
| Who pays for model | Your Claude Code subscription        | The deployment's Netlify credits                    |
| Where videos live  | `./videos/` on your disk             | The team's site, with share links and embeds        |
| Review             | You                                  | Comments, approvals, roles and webhooks             |
| Good for           | Trying it, one-off videos            | Teams, CI, pull request demos, publishing to a page |

You can start with `local` and move to a deployment later. The prompts and flags are the same.

## Install

```sh
# Global install
npm install -g netlify-video-agent

# Or run it without installing
npx -y netlify-video-agent@1 --version

# Or from source
git clone https://github.com/netlify-labs/video-agent.git
cd video-agent && npm install && npm run build:packages
node packages/cli/dist/bin.js --version
```

It needs Node 22 or later.

## On your machine

Local mode needs [Claude Code](https://claude.com/claude-code) and its sandbox: Seatbelt on macOS (built in), or
`bubblewrap` and `socat` on Linux. The first run installs a pinned renderer and ffmpeg, which takes about 2 GB.
`video-agent doctor` shows what's there and what's missing:

```text
Local mode (video-agent local):
  ✓ agent: Claude Code 2.1.322 (Claude Code)
  ✓ sandbox: macOS Seatbelt
  ✓ runtime: installed on the first local run
  ✓ ffmpeg: /opt/homebrew/bin/ffmpeg (the first local run installs a pinned copy)
  ✓ python: Python 3.13.12 (for --voice)
  ✓ disk: 11.7 GB free (local mode needs about 2 GB)
```

| Command                       | What it does                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `local <prompt>`              | Makes a video. `--aspect`, `--duration`, `--sound`, `--voice`, `--media`, `--look`, `--context`, `--out` |
| `local revise <dir> <change>` | Makes the next version. `--scene` redoes only those scenes                                               |
| `record <url>`                | Records a web app in Chromium, with a pointer trace. `--privacy` hides emails, keys and tokens           |
| `local demo <recording>`      | Makes a demo from a recording. `--quick` uses no agent and no model                                      |

A demo from your own app, start to finish:

```sh
video-agent record http://localhost:3000 --out ./take1 --privacy
video-agent local demo ./take1 --prompt "Adding a webhook, for new admins"
```

## With a deployment

Sign in once. The site's address and your key are saved, so later commands need no flags.

```sh
video-agent login --url https://<your-site>
video-agent create "A 20-second launch video for our webhooks feature" --aspect 16:9 --wait --out ./webhooks
video-agent revise vid_01… "Make the end card orange" --wait
video-agent publish vid_01… --json
```

`login` opens your browser to approve this machine. Over SSH or in a container, add `--no-browser` to print the
address and code instead. `publish` prints the share link, the MP4 link and an embed snippet.

| Group   | Commands                                                                                |
| ------- | --------------------------------------------------------------------------------------- |
| Make    | `create`, `revise`, `redo`, `remix`, `restyle`, `retry`, `cancel`                       |
| Read    | `get`, `list`, `scenes`, `looks`, `wait`, `download`, `open`                            |
| Review  | `comments list`, `comments add`, `verdict`, `tag`                                       |
| Share   | `publish`, `unpublish`                                                                  |
| Media   | `media upload`, `media list`, `media get`                                               |
| Account | `login`, `logout`, `whoami`, `keys list`, `keys revoke`, `doctor`                       |
| Briefs  | `brief pr`, `brief release`, `brief changelog` (pipe one into `create --prompt-file -`) |
| Any     | `api <method> <path>` calls any route, like `gh api`                                    |

A demo video for a pull request, in one line:

```sh
video-agent brief pr https://github.com/acme/web/pull/123 | video-agent create --prompt-file - --wait
```

Run `video-agent help <command>` for a command's flags and examples.

## Configuration

Each value comes from the first place that has it:

| Order | Site address                        | API key                             |
| ----- | ----------------------------------- | ----------------------------------- |
| 1     | `--url`                             | `--key` (`--key -` reads stdin)     |
| 2     | `VIDEO_AGENT_URL`                   | `VIDEO_AGENT_KEY`                   |
| 3     | `~/.config/video-agent/config.json` | `~/.config/video-agent/config.json` |

`login` writes the config file. `logout` forgets the key, and `logout --revoke` also revokes it on the server.
There's no default site: the CLI only talks to the deployment you name.

In CI, set the two environment variables and skip `login`:

```yaml
env:
  VIDEO_AGENT_URL: https://<your-site>
  VIDEO_AGENT_KEY: ${{ secrets.VIDEO_AGENT_KEY }}
```

`VIDEO_AGENT_DEBUG=1` (or `--verbose`) logs each request and step as JSON lines on stderr.

## Scripting

`--json` prints one JSON object on stdout and nothing else there. Progress and messages go to stderr.

```sh
id=$(video-agent create "A 15-second teaser" --json | jq -r .id)
video-agent wait "$id" --timeout 30m || echo "exit $?"
video-agent download "$id" --file all --out ./teaser
```

### Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| 0    | Done                                                                     |
| 1    | Something else failed (network, server error); the message says what     |
| 2    | The command was called wrong (unknown flag, missing argument, bad value) |
| 3    | No key, a revoked key, or a login that was denied or expired             |
| 4    | The video or item is missing, or your role can't see it                  |
| 5    | The video failed (`--wait`); `get <id>` shows why                        |
| 6    | `--wait` gave up (`--timeout`); the video is still being made            |
| 7    | Not now: a run is in progress, a feature is off, or the state changed    |
| 8    | Too many requests; retry after a pause                                   |
| 9    | This server doesn't offer that feature                                   |

## Troubleshooting

| You see                                                        | Fix                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `No server set: run video-agent login --url <your deployment>` | Run that, or set `VIDEO_AGENT_URL`. `local` and `record` need no server               |
| `… doesn't look like a Video Agent site`                       | Use the address of the site you deployed, like `acme-video.netlify.app`               |
| `CLI sign-in isn't available on this server`                   | Create a key on `<your-site>/keys`, then `video-agent login --key -` and paste it     |
| `The code expired. Run video-agent login again.`               | Approve the code in the browser sooner; codes are short-lived                         |
| `Install bwrap and socat`                                      | On Linux, install `bubblewrap` and `socat`. Claude Code's sandbox needs them          |
| Exit 9 on `redo`, `remix`, `looks`, `restyle` or `tag`         | The deployment is older or has the feature off. `whoami` lists its features           |
| A local run fails                                              | Its workspace is kept. Run again with `--verbose`, or raise `--timeout` (default 40m) |

## Limitations

- **Local mode supports Claude Code only.** `--agent` takes `claude`.
- **Local mode needs macOS or Linux,** because the agent runs inside Seatbelt or bubblewrap.
- **Videos take minutes, not seconds.** A local run stops after 40 minutes unless you raise `--timeout`.
- **`--voice` in local mode needs Python 3.10 to 3.13.**
- **Some commands depend on the deployment.** `redo`, `remix`, `looks`, `restyle` and `tag` need a server that
  lists the feature.
- **Local videos stay local.** Share links, comments and approvals need a deployment.

## FAQ

**Do I need a Netlify account?**
Not for `local`, `local demo` or `record`. You need one to host a deployment.

**Does local mode send my prompt or files to Netlify?**
No. The work goes through your own Claude Code. A video that uses web fonts or library music fetches them from
their public sources.

**How do I make videos match my brand?**
Put a `./context/` folder beside where you run the command, or pass `--context <folder>`. Or pass `--look` with a
bundled Look id (`clean`, `editorial`, `terminal`, `swiss-grid` and others) or a look folder.

**Can I edit the video by hand?**
Yes. `source.tar.gz` in each version folder is the HTML it was rendered from.

**How do I use it from Node instead of a shell?**
Use [`netlify-video-agent-sdk`](https://www.npmjs.com/package/netlify-video-agent-sdk), the typed client this CLI is
built on.

**How do I show a published video on my own page?**
Use [`netlify-video-agent-player`](https://www.npmjs.com/package/netlify-video-agent-player), or paste the embed
snippet that `publish` prints.

## License

MIT
