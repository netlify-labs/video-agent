# Contributing

Thanks for helping. Run `npm install`, then `npm run typecheck && npm run lint && npm test` before you open a pull
request; `npm run test:ui` too if you changed `app/web/`. See [Developing](../README.md#developing) for running it locally.

## Add a look

A look is a named visual style (type, colour roles, motion, layout) that people pick for a video. Each one is a folder
in [`app/looks/`](../app/looks/README.md): no backend code, just rules, an example composition and a preview. It's a good first
pull request. The full guide is [app/looks/README.md](../app/looks/README.md); in short:

1. `npm run look:new <id>`, then write `LOOK.md` and build `example/` (editing contract v1).
2. `npm run look:vendor <id>` for any HyperFrames registry items you use, then `npm run look:check -- --static <id>`
   and `npm run look:check <id>` until both pass.
3. Render `preview.mp4` and `poster.webp` with the commands in the guide.
4. Try it on the three prompts in [`app/looks/PROMPTS.md`](../app/looks/PROMPTS.md) and attach a GIF of each to the pull request.

The quality bar: **original** (a genre is fine; no imitation of a specific company's, film's or show's identity),
readable at phone size in all four shapes, on-brand for any brand's colours, seek-safe, and licensed (every asset in
`credits.json`, every registry item in the lock).

Looks are instructions to the agent, like `context/`, so they arrive only through reviewed pull requests. CI runs
`look:check` on the `pull_request` trigger only (never `pull_request_target`), so a contributed example runs with no
secrets.

Have an idea but not the time? [Propose a look](ISSUE_TEMPLATE/propose-a-look.md).
