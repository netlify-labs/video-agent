# netlify-video-agent

The `video-agent` command for [Video Agent](https://github.com/netlify-labs/video-agent): make videos from a prompt,
on your own machine with your own coding agent, or with a Video Agent deployment. It needs Node 22 or later.

```sh
npm install -g netlify-video-agent
video-agent --version
# or without installing:
npx -y netlify-video-agent@1 --version
```

## On your machine

You don't need a deployment for this. The CLI makes the video with your own
[Claude Code](https://claude.com/claude-code), inside a sandbox.

```sh
video-agent doctor
video-agent local "A 20-second launch video for our webhooks feature" --aspect 16:9
video-agent local revise ./videos/webhooks-launch "Make the end card orange"
```

Each version lands in `./videos/<name>/vN/`. If you have a `./context/` folder, it's used as your brand.

## With a deployment

Sign in once. The site's address and your key are saved to `~/.config/video-agent/config.json`, so later commands
need no flags.

```sh
video-agent login --url https://<your-site>
video-agent create "A 20-second launch video for our webhooks feature" --aspect 16:9 --wait --out ./webhooks
```

In CI, set `VIDEO_AGENT_URL` and `VIDEO_AGENT_KEY` instead. A `--url` or `--key` flag overrides both.

For every command, run `video-agent --help` or `video-agent <command> --help`.

## License

MIT
