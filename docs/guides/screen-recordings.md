# Screen recording demos

A **demo** turns a raw screen recording into a finished product video: an intro, one scene per step of what you did
with auto zoom that follows the action, a smooth cursor and click ripples, dead time cut or sped up, a callout per
step, hidden areas over private things, and an outro in your brand (or a Look). It's an ordinary video afterwards:
versions, comments, the editor, publishing and remix all work.

- **Getting the recording in:** upload it to the library with the `screen-recording` role (`POST /api/v1/media/uploads`
  with `"role": "screen-recording"`, or the SDK's `media.uploadRecording`). A recording made by a script can come with
  a **pointer trace** (`PUT /api/v1/media/{id}/trace`): exact clicks with the clicked element's role and name, the
  cursor path, typing (how many keys, never which), scrolls, navigations (the path only) and boxes to hide that follow
  a field as the page scrolls. Without a trace, clicks and the cursor are inferred from the pixels.
- **The format:** H.264 MP4, 24 to 30 frames per second, a keyframe at least every 2 seconds, fast start, at most
  5 minutes, 150 MB and 4096 pixels on a side. Anything else is refused with what to run instead (an `ffmpeg` command).
- **Making the demo:** `POST /api/v1/videos` with `{"prompt": "…", "recording": {"mediaId": "med_…"}}` and optionally
  `trim: [in, out]` (seconds) and `redact: [{start, end, box: [x, y, w, h]}]` (fractions of the frame) to hide things
  from the start (blurred; add `"style": "solid"` for a flat box). A box covers the whole recording unless you give
  `start` or `end`. Without `durationSec`, the target is about 0.4 of the recording used, 20 to 90 seconds. Remix takes
  `recording` too (a new recording, the same request and look); without it, a demo's remix keeps its recording. From
  AI tools, `create_video` and `remix_video` take `recording_media_id`, `trim` and `redact`. Demos are made with
  HyperFrames only (`409 engine_unsupported` otherwise).
- **Quick demo:** add `"agent": false` and the run composes the demo straight from the plan, with no authoring: a stock
  intro and outro, a scene per step, callouts from what was clicked. It costs about as much as an edit render. It
  needs a recording and takes no voice-over.
- **Hidden areas are cosmetic.** They blur the picture under them in the render (heavily enough that small text such
  as an email or a key can't be read), or are a solid box if you choose `"style": "solid"` for one; the recording file
  underneath is unchanged and stays in your library. Boxes from the trace and the ones you add when you create the
  demo are locked: the agent and the editor can add boxes but never remove or move those, and a render that lost one is
  refused (`redaction_removed`). You can shorten (or lengthen) when one of your own boxes hides, in the editor's Hide
  tab (the `boxSpan` edit op); where it is and how it looks stay.
- **Privacy mode is opt-in** (`"privacy": true` in `recording`, or the setup checkbox). Off, the default: only the
  areas you draw and the trace's (password fields, `--hide` selectors) are hidden, so URLs and names stay visible. On:
  the run reads the recording (OCR of sampled frames, about a second a frame, at most 90 seconds) for emails, keys and
  tokens, URLs that carry ids, card and phone numbers, proposes a hidden area over each, and the agent looks at every
  one, drops what isn't private and hides what the reading missed (names, for instance). **Hide strings**
  (`"hideStrings": ["Acme Labs", …]`, or "Hide these words" in setup) are hidden wherever they're read, privacy mode or
  not, and the rendered video is read back: if one is still readable, the run fixes it before it finishes. In privacy
  mode that read-back also looks for emails, keys and the rest; what it still finds is a warning, not a failure: the
  Hidden list and Publish say "An email may still be readable at 0:12" (the version's `recording.privacyWarnings`),
  and you hide it in the editor if it's private. A demo with
  any hidden area, privacy mode or hide strings **starts private**: check its Hidden list (the version's
  `recording.hidden`, where each entry's `why` says why it's hidden) before you make it public. OCR can miss text
  (small, low contrast, moving): privacy mode lowers the risk of a demo showing something private, it doesn't remove
  it.
- **Who sees the recording:** like voice recordings, a raw screen recording is readable by the person who uploaded it
  and by admins; once a video uses it, Creators who can see that video can too. Runs read it from Blobs (see the [trust
  model](deploy.md#trust-model-plainly)). Retention and the per-person budget are in [Your own voice-over](voice-over.md).
- **Credits:** a demo is one authoring run (analysis of the recording happens inside it, on the runner). Editor changes
  (trim, camera, cursor, hidden areas) render like any other edit.
