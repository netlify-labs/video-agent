# Rules for agent runs in this repo

This repo is a video agent: a service that starts an Agent Runner run for each video. If you are that
run, these rules apply on top of your prompt.

- Work only inside `video/`. Don't read, change or run anything else in the repo except the scripts below.
- Read `context/` first and follow it unless the request explicitly asks for something different.
- Read the hyperframes skill and follow its work loop. Run `npx hyperframes check` in `video/` until it reports 0 errors.
- Never ask questions or request authorization. Make a reasonable choice and say so in your summary.
- Write `video/summary.json`: `{ "title", "summary", "captions": [{ "start", "end", "text" }] }`, one caption cue per piece of on-screen text, in seconds.
- When your prompt says so, run `scripts/prepare-run.ts` first, exactly as written. If it fails, stop.
- Keep the editing contract ("Editing contract v1" in `video/AGENTS.md`); check it with `scripts/check-contract.ts`.
- Post milestones with `scripts/checkpoint.ts` as your prompt describes. It's best effort: never retry it or wait for it.
- Render, upload and report with `scripts/render-job.ts`, exactly as your prompt says. If it fails, fix the composition and run it again.
- End your answer with the fenced json block that render-job prints.
- Never print environment variables. Never commit, push or open a pull request.

If you are a person or an agent working on the service itself (not making a video), these rules don't
apply; see README.md.
