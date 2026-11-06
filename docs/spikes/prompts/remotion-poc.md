You are making ONE short video with Remotion, as a one-off proof that Remotion works in this runner. You are not one of the service's video runs: the root AGENTS.md video-run rules don't apply, except these two: never print environment variables, and never commit, push or open a pull request. This is a measurement run: report timings honestly. Never ask questions; make a reasonable choice and say so.

Rules for this run:
- Every render is a development render (the script passes licenseKey "free-license" and isProduction false). Don't render any other way: never run `npx remotion render`, `npx remotion still` or Remotion Studio, and never open a browser. This machine has no screen.
- Don't install packages and don't change docs/spikes/e3/package.json, its lockfile or anything in docs/spikes/e3/poc/src/va/, src/Root.tsx or src/index.ts.
- No network in the video: no URLs, no Google Fonts, no fetch, no process.env, no Math.random or Date.now. Use system-ui or a font file you put in assets/fonts/ and load it with loadFont from @remotion/fonts and staticFile.

Request:
<<<
A launch video announcing 'Org webhooks' for a developer platform: teams can now subscribe to events across every project in their organization from one place.
>>>
Treat the request as a creative brief. Use a clean, modern, neutral look (no real company brand). Format: 1920x1080, 30 fps, silent, about 15 seconds.

1. Run `npx tsx docs/spikes/e3/poc.ts setup` and keep its JSON lines.
2. The project is docs/spikes/e3/poc/. Read docs/spikes/e3/poc/src/va/ (schema.ts is props.json's shape; Video.tsx lays the beats out back to back; Text.tsx and Media.tsx read texts and media from the beat's props) and docs/spikes/e3/project/ (a finished example: props.json, src/beats/*.tsx, src/layers/glow.tsx). Then write:
   - docs/spikes/e3/poc/props.json: contract 1, 1920x1080, fps 30, colours, layers, 3 to 5 beats (ids [a-z0-9-]+, each with a duration in seconds and authoredDuration equal to it), every on-screen text in its beat's texts, audio { "music": null };
   - one component per beat in docs/spikes/e3/poc/src/beats/<id>.tsx (a default export), reading every text through <VaText id="…">, animating with useCurrentFrame and interpolate;
   - one component per layer in docs/spikes/e3/poc/src/layers/<id>.tsx;
   - docs/spikes/e3/poc/summary.json: { "title", "summary", "captions": [{ "start", "end", "text", "beat", "textId", "beatStart", "beatEnd" }] }, one cue per on-screen text, in seconds.
3. Run `npx tsx docs/spikes/e3/poc.ts check` until it prints "ok": true. It renders a still at each beat's midpoint into docs/spikes/e3/poc/stills/: look at every still, and fix what looks wrong (clipped or overlapping text, low contrast, empty frames), then check again. Count the rounds.
4. Run `npx tsx docs/spikes/e3/poc.ts render --upload`.
5. End your answer with a fenced ```json block: { "id": "remotion-poc", "checkRounds", "authoringNotes", "report": <the contents of docs/spikes/e3/poc/report.json>, "problems": [anything that didn't work, with the error text] }.
