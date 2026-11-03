# Your own voice-over

A person can narrate a video in their own voice: they record (or already have) an audio file, you place it on the
video, and a render mixes it over the visuals. The visuals stay exactly as they are; music dips under the voice, and
the captions follow the recorded words. The tools are listed when your role can edit videos (Creators and admins).

## 1. Upload the recording

The MCP tools take media ids only: they never fetch a URL. Upload the file with an API key through an upload session
(recordings always use one, whatever their size), naming its role and the video it's for:

```sh
FILE=take.m4a
SIZE=$(wc -c < "$FILE" | tr -d ' ')
SHA=$(shasum -a 256 "$FILE" | cut -d' ' -f1)
# 1. Start the session (the video id is the one you'll narrate).
curl -fsS -X POST "{{SITE_URL}}/api/v1/media/uploads" \
  -H "Authorization: Bearer $VIDEO_AGENT_API_KEY" -H "content-type: application/json" \
  -d "{\"filename\":\"$FILE\",\"size\":$SIZE,\"sha256\":\"$SHA\",\"role\":\"narration-upload\",\"scopeJobId\":\"vid_…\"}"
# 2. Send each part (partSize and partCount are in the answer), index from 0, with its sha256.
curl -fsS -X PUT "{{SITE_URL}}/api/v1/media/uploads/<id>/parts/0" \
  -H "Authorization: Bearer $VIDEO_AGENT_API_KEY" -H "content-type: application/octet-stream" \
  -H "x-part-sha256: <sha256 of the part>" --data-binary @part0
# 3. Finish it, then poll GET /api/v1/media/uploads/<id> until status is "done"; mediaId is the recording.
curl -fsS -X POST "{{SITE_URL}}/api/v1/media/uploads/<id>/complete" -H "Authorization: Bearer $VIDEO_AGENT_API_KEY"
```

A recording someone else made is only usable when you can see it (yours, or one already used in a video you can
see). An audio item from `list_media` works too.

## 2. Place it

Call `add_narration` with `video_id`, `media_id` (the recording) and `start_seconds` (where in the video it starts),
and optionally `gain_db` (its level, default 0) and `language` (the language spoken, so the captions are transcribed
in it; owner or admin). It adds the recording, whole, to your draft of the latest ready version and saves the draft.
Call it again for each further recording; where two overlap, the later one wins.

- **The narration lock.** One person at a time edits a video's narration. `add_narration` takes the lock; if someone
  else holds it the answer is `NARRATION_LOCKED` with who. Tell your user who is editing it and wait: never work
  around it. Your hold lapses two minutes after your last call.
- **Limits.** At most 32 recordings and 200 clips, and the narration may run at most two minutes past the end of
  the video (15 minutes in all). The answer says when a limit is hit.

`get_narration` with `video_id` shows the clips (in seconds) and your draft; with `version`, the narration a version
was rendered with and its captions' status.

## 3. Render

**Ask before spending a run**: a render costs credits, like a revision. Then call `render_with_narration` with
`video_id` and `mode` "keep_visuals" (pass `edit_id` for a draft other than your latest one). With
`hold_final_frame`, narration that runs past the end holds the last frame until it finishes; without it, it's cut
off. "fit_to_narration" (retiming the visuals to the narration) isn't available yet, and a draft without narration
is refused. Follow the new version with `get_video` as usual.
