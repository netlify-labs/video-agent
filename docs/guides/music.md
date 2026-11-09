# Music from Openverse

Creators and admins can search [Openverse](https://openverse.org) from the Media page (**Find music**), the media
picker, or the MCP tools `search_music` and `import_music`. Every call goes through the server
(`GET /api/v1/media/openverse/search`, `POST /api/v1/media/openverse/import`); the browser never talks to the
Openverse API.

- **Slow Openverse.** Openverse's audio search can take a minute, longer than an API request may run. A request
  tries for 6 seconds; if Openverse hasn't answered by then, it answers `202` with a job (and a `Location` header,
  `/api/v1/media/openverse/jobs/{id}`). The `openverse-background` function runs it with 60-second calls, retries
  timeouts and 5xx with backoff, and waits out a 429's `Retry-After`. Poll the job until `status` is `done` (with
  `search` or `media`) or `failed` (with `error`). Only the person who started a job can read it; jobs are kept for 30
  minutes. Identical requests share a job, and each person can start 12 searches or imports a minute. The MCP tools
  wait about 8 seconds, then answer `status: "pending"` with a `job_id` for `get_music_job`.
- **Stored searches.** Every search Openverse answers is stored in the database (`openverse_searches`, keyed by the
  search with case, spaces, licence, kind and page normalized) and answers the same search from anyone, on any
  function instance, at once: fresh for 24 hours, then for up to 14 days marked `stale: true` (with `fetchedAt`) while
  one background job refreshes it. Only the tracks are stored; whether one is in the library (`mediaId`) is looked up
  for every request. The server's music picks use the same stored searches. The sweep deletes searches older than 14
  days and keeps at most 5,000.
- **Daily warm-up.** The `openverse-warmup` function (daily, 05:17 UTC) queues one background job that refreshes the
  common searches (`GET /api/v1/media/openverse/common`: upbeat, ambient, corporate, cinematic, acoustic, piano, lofi
  and more; music, CC0 and CC BY, first page) and the 15 most used first-page searches of the last 14 days, skipping
  any fetched in the last 20 hours. It runs three at a time, starts each at least 4 seconds after the last, and stops
  when Openverse says it's busy. Find music offers the common searches as quick picks.
- **Library first.** `GET /api/v1/media/openverse/library?q=` returns ready audio already in the library whose title,
  caption, filename, creator or source title matches the words (every word matched first, then Openverse imports),
  without asking Openverse. Find music shows them at once under **In your library**, above Openverse's tracks, and
  `search_music` lists them in `in_library` so agents reuse a track before importing another.
- **Licences: CC0 and CC BY only.** NC (non-commercial), ND (no derivatives) and SA (share-alike) tracks are never
  shown or imported, whatever Openverse returns: videos are often commercial, they're edited and re-cut, and a
  share-alike track would put its licence on the whole video. CC0 needs no credit; CC BY needs one, which the app adds.
- **Import** takes only the Openverse id. The server reads the track from Openverse again, checks the licence,
  downloads the file over HTTPS (at most 3 redirects, 50 MB, 25 seconds or 3 minutes in a job; hosts that resolve to
  private addresses are refused) and keeps it only if its bytes are MP3, M4A, WAV or Ogg audio of 10 minutes or less. It becomes a normal
  library item with its source, licence, creator and Openverse's attribution recorded. Importing the same track again
  returns the same item.
- **Attribution** comes from the library, not from the agent: a version made with a CC BY item lists it in the
  version's `credits`, the video page shows "Music: _title_ by _creator_, CC BY 4.0" with links, and the public share
  page and the embed snippet carry the same line. A silent version isn't credited for a track it never used.
- **Before runs.** When Sound is Music (or Music + effects) and the version has no track, picked or inherited, and
  the brand has none, the server picks one before the run starts: the attempt shows **Finding music…** (stage
  `finding_music`) while background Openverse jobs search with a short query (from the AI Gateway's fast model when
  it's available, else mood words in the request) and import the best CC0 or CC BY track, long enough for the video
  if possible. It joins the version's media like a picked track, owned by the version's author, so it's credited the
  same way. A search that fails or finds nothing importable moves on to the next words, one at a time: the query,
  its fallback, then broad searches ("upbeat electronic", "ambient", "corporate", "acoustic", "cinematic") ordered to
  suit the request's mood; each is listed in the pick's `tried`. These searches don't retry, since a query Openverse
  times out on usually keeps timing out. When no Openverse track is chosen within 5 minutes, every search is spent or
  three fail in a row, the server uses the best audio already in the team library instead (ready items only, the
  ones everyone in the team sees): Openverse imports first, since they're licensed and credited, then titles and
  captions that match the mood, then tracks long enough for the video, then the most recently used or added. The pick
  shows `source: "library"` and the video page "Music: _title_ (from your library)". Only an empty library (no audio
  at all) starts the run without a track, and it finds music itself (below). Revisions inherit the track; a version
  can be cancelled while it's finding music.
- **Starter music.** To give that fallback something to use, seed the library with tracks across moods
  (upbeat, ambient, corporate, cinematic, acoustic, playful, inspiring, lofi). It's optional and not part of
  `npm run setup`:

  ```sh
  VIDEO_AGENT_KEY=<a Creator's or admin's API key> npm run seed:music -- --site <your project or its https URL> [--count 12] [--cc0-only]
  ```

  It goes through the site's own Openverse endpoints like Find music: searches each mood for CC0 and CC BY tracks of 30
  seconds to 4 minutes the library can take (CC0 first), imports them with captions naming the mood (which the fallback matches), follows
  `202` jobs, waits out 429s and slow answers with backoff, skips tracks already in the library, and prints what it
  imported (title, creator, licence, length). CC BY tracks are credited automatically on videos that use them (most music on
  Openverse is CC BY); pass `--cc0-only` if you want no credit lines. A project id or name is
  looked up with your Netlify login; an https URL is used as is.

- **In runs.** When the server's pick found nothing, not even in the library (or the version predates it), the agent finds a track itself with
  `scripts/openverse.ts` (same licence rules, files over HTTPS up to 10 MB so they fit the preview bundle, CC0 first).
  The script records each file's licence in the composition's `assets/music/credits.json`; finalize reads it from the
  saved composition, keeps only valid CC0/CC BY entries for files an `<audio>` plays, and stores them on the version,
  so those tracks are credited like library ones, also after revisions and edits. Runs use the same
  `OPENVERSE_CLIENT_ID`/`OPENVERSE_CLIENT_SECRET` (set for builds as well as functions) or search anonymously.
- **Previews** play from the track's source site (Jamendo, Freesound, Wikimedia Commons) when someone presses play.
- **Rate limits.** Anonymous Openverse access is limited per IP address, and Netlify Functions share outbound
  addresses, so register an app for steady use. One command does it and stores the credentials on your project
  (the secret is never printed):

  ```sh
  npm run setup:openverse -- --site <your project> --deploy
  ```

  It uses your Netlify login's email for Openverse (or `--email` / `OPENVERSE_EMAIL`), registers an app named after your site (names are unique
  across Openverse; pass `--name` to choose another), sets `OPENVERSE_CLIENT_ID` and `OPENVERSE_CLIENT_SECRET`,
  and with `--deploy` redeploys so the functions pick them up. Then click the verification link Openverse emails
  you: until then the app has anonymous limits. `npm run setup` offers the same step, and the setup page shows
  whether searches run as a registered app. The server swaps the credentials for a token and keeps it until it
  expires. Searches are stored (above), and when Openverse says it's busy the app waits before asking again and says
  "Openverse is busy, try again in a minute."
