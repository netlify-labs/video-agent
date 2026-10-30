You are making one video from scratch. Work only inside video/. This is a measurement run: report timings honestly.

Request:
<<<
A docs tutorial snippet explaining in three steps how to add an environment variable to a project and redeploy it.
>>>
Treat the request as a creative brief. Use a clean, modern, neutral look (no real company brand).

Format: 1080x1080, 30 fps, silent. Aim for about 60 seconds.
Never ask questions. If something is unclear, make a reasonable choice and say so.

1. Read the hyperframes skill and follow its work loop. The project is video/.
2. Write video/index.html for a 1080x1080 composition.
3. Run `npx hyperframes check` in video/ until it reports 0 errors. Count how many check rounds it took.
4. Render three times from video/, timing each with `date +%s.%N` before and after:
   `npx hyperframes render --quality looks --output /tmp/s1/looks.mp4`, then `--quality standard --output /tmp/s1/standard.mp4`, then `--quality delivery --output /tmp/s1/delivery.mp4`.
5. For each file: size in bytes and `ffprobe -v error -show_entries format=duration:stream=width,height,codec_name -of json`.
6. Upload the standard render for review: find the netlify CLI (`command -v netlify || ls /opt/buildhome/node-deps/node_modules/.bin/netlify`), then `<cli> blobs:set spike-s1 c/standard.mp4 --input /tmp/s1/standard.mp4`.

Never print environment variables. Never commit, push or open a pull request.
End with a fenced ```json block: { "id": "c", "checkRounds", "authoringNotes", "renders": { "looks": {"seconds","bytes","durationSec","width","height","codec"}, "standard": {...}, "delivery": {...} }, "uploaded": true|false, "notes" }.
