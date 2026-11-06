# Recipes

Each recipe ends with a run that costs credits: confirm the brief with the person before `create_video`,
`revise_video` or `remix_video`, unless they already said to go ahead. Then follow the run with `get_video` (`wait_seconds: 8`) and
share the result.

## Pull request → demo or launch video

1. Read the PR: title, description, linked issues, the diff and any screenshots or recordings in the description.
   With the GitHub CLI: `gh pr view <url> --json title,body,files` and `gh pr diff <url>`.
2. Work out the story for someone who uses the product, not for the reviewer: what they can do now that they couldn't
   before, and the one or two screens that show it. Leave out refactors, tests and internals.
3. Media: check `list_media` for the logo and existing product shots. Download the PR's screenshots and upload them
   with a caption each (see [connect.md](connect.md), "Uploading media"); keep the returned ids.
4. Write the prompt: who it's for, the one message, three or four beats (problem, the new thing on screen, the result),
   exact on-screen text in quotes, and the end card (for example the feature name and "Available today").
5. Optionally plan: `plan_video` with that prompt and the `media_ids`, ask the questions, `plan_brief`.
6. Look for the PR's video first: `list_videos` with the PR URL as `query` and `mine: true`. If one exists,
   `revise_video` it with what changed rather than making a second video. Otherwise `create_video` with the prompt,
   `aspect` (16:9 for docs and launches), `duration_sec` (20 to 45), `media_ids` and `plan_id` if you planned. End the
   prompt with a line `Pull request: <PR URL>` so the lookup finds it next time. Don't use the PR URL alone as the
   `idempotency_key`: a key is tied to its exact request for 24 hours, so once the description changes it answers
   `409`. If you need one for retries, make it new per attempt (the PR URL plus the time).
7. When it's ready, give the person `web_url`. If they want it in the PR, `publish_video` and paste the share page
   link or the GIF into a PR comment.

To do this on every labelled PR, use the GitHub Action (see /docs/github on the Video Agent site).

## Release notes or changelog → changelog video

1. Read the notes (a CHANGELOG section, a GitHub release, or text the person pastes).
2. Pick three to five changes a user would notice. Each becomes one beat with a short headline in quotes and, if you
   have one, a screenshot from the library.
3. Prompt: "A changelog video for <product> <version>: an opening title "What's new in <version>", one beat per
   change with its headline, ending on <URL or call to action>." 30 to 60 seconds, 16:9, or 1:1 for social feeds.
4. `create_video` with the prompt, `title` (for example "Changelog 2.4"), `media_ids` and `aspect`.
5. `publish_video` when the person approves, and put the share page or embed in the release notes.

To do this on every release, use the GitHub Action (see /docs/github on the Video Agent site).

## Long video → 15-second vertical social cut

Aspect is fixed per video, so a vertical cut is a new video made from the long one.

1. `get_video` on the long video: read the latest ready version's `prompt` and `output.summary`, and its title.
2. Pick the single strongest moment or message. Fifteen seconds holds one idea and an end card.
3. `create_video` with `aspect` "9:16", `duration_sec` 15, the same `media_ids` you used for the long video, and a
   prompt that says it is a vertical social cut of the named video: the one message, large captions that read without
   sound, the hook in the first two seconds, and the same end card.
4. To trim further, `revise_video` the cut ("shorter opening", "bigger captions") rather than creating again.

## Remix a video

Pick the tool by what the person should end up with:

- `revise_video`: the same video, changed. It adds the next version ("make the end card orange", "shorter").
- `remix_video`: a NEW video, their own, that starts from an existing video's finished composition. Anything from
  "the same video with our new product name" to "a video like this one about webhooks", or the same video in another
  shape. The source can be anyone's video they can see.
- `create_video`: a new idea with nothing to start from.

1. `get_video` on the source and pick the ready version to start from (`from_version`; the latest ready one by
   default). Read its prompt and summary so you know what's there.
2. Write `change` as what should be different, not the whole video. Targeted: "Keep everything, but swap the product
   name to Orbitly." New topic: "Same format and pacing, but about our payments API. Rewrite the script and on-screen
   text for it." The agent keeps whatever the change doesn't mention.
3. Leave out `aspect`, `duration_sec`, `sound`, `voiceover` and `media_ids` to keep the source's. `media_ids` replaces
   the source's list. A new `aspect` makes the agent re-lay out every scene, so say so to the person.
4. Optionally plan: `plan_video` with the prompt and `remix_of` set to the source, then `plan_brief`, and pass its
   `plan_id` to `remix_video`.
5. `remix_video` returns the new video's `video_id` at once. Follow it with `get_video` like any new video; its
   `remix_of` names the source.

Recorded narration is dropped (tell the person, if the source had one), and comments, verdicts and publications stay
with the original. A remix of a private video is private. If an admin has turned remixing off, `remix_video` is
refused: offer `revise_video` or `create_video` instead.

## Localise captions and on-screen text

1. `get_video` and note the ready version to translate from (the base). Agree the languages with the person, and
   whether names, product terms and the URL stay in English.
2. For each language in turn, `revise_video` with `from_version` set to the base and a `change` like: "Translate every
   caption and on-screen text into German. Keep timing, layout, names and the URL. Shorten lines that no longer fit
   rather than shrinking the type."
3. Only one version can be in progress, so wait for each with `get_video` before starting the next. Note which
   version is which language.
4. Share each version's link with its language, or `publish_video` with `version` for each.

## Review loop

1. `list_comments` with `video_id` (and `version`) to read the feedback. Open comments have no `resolved_at`;
   pinned ones have `time_sec`, a moment in the video.
2. Watch the version (`get_video` gives the MP4) and add your own points with `add_comment`: one comment per point,
   saying what to change and why, pinned with `time_sec` when it's about a moment.
3. Record a verdict with `set_verdict`: "approved" or "changes_requested", with a short `note`. You can't review your
   own version.
4. To act on the feedback (the video's owner or an admin): `revise_video` with the `comment_ids` to incorporate and a
   `change` that summarises them. The new version records which comments it addressed (`addressed_in`). When the
   comments are pinned to moments in one or a few scenes, prefer redoing those scenes (see "Redo a scene").
5. Repeat until it's approved, then `publish_video`.

## Redo a scene

When a change is about one or a few scenes ("the second scene's headline", "the part at 0:12"), redo only those:
everything else stays exactly as it is, so nothing else drifts, and it costs less than a whole revision.

1. `get_video` with `video_id`. Each ready version lists its scenes in `beats` (`id`, `label`, `start`, `duration`
   in seconds). Find the scene by its label, or by the moment: the scene whose `start` ≤ t < `start + duration`.
2. `revise_video` with `video_id`, `from_version` (the version those scenes belong to), `beats` (the scene ids) and
   `change` (what should change in them). Leave out `plan_id`, `duration_sec`, `sound` and `voiceover`; say in
   `change` if a scene should run longer or its line should change.
3. Follow the run with `get_video` (or `show_video`) until it's ready. If it fails because the run changed things
   outside those scenes, retry it once; if it fails again, revise the whole video instead.
4. Review only the redone scenes: the rest is unchanged by design. The new version says which it redid
   (`redid_scenes`).
