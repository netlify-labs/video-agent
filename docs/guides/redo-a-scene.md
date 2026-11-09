# Redo a scene

A **scoped revision** redoes one or more scenes of a finished version and leaves the rest alone. Pick the scenes, say
what should change, and you get a new version where only those scenes were rewritten. Everything else in the
composition is copied from the version you started from, not regenerated.

- **What's guaranteed:** the saved composition outside the picked scenes is the parent's, byte for byte. The run gets
  a spliced copy where the frozen scenes are put back verbatim, and finalize checks that again before it stores
  anything. A run that changes a frozen scene is refused, nothing is stored, and **Try again** tells the next run
  what it touched.
- **What's checked more loosely:** the rendered MP4 is checked by length (within a quarter of a second of the
  spliced composition). Pixels in frozen scenes aren't compared frame by frame on every run; the redo-a-scene live
  test measures how far they drift.
- **Limits:**
  - The version must keep the editing contract (the versions you can **Edit** in the browser) and be made with
    HyperFrames.
  - Pick 1 to 20 scenes, and not every scene: that's a whole-video revision.
  - Name the version the scenes are from (`fromVersion`), since scene ids belong to one version.
  - Length, sound, voice-over and plans stay the parent's. Say in the request if a scene should run longer; the
    scenes after it move.
  - The scene that ends the video under recorded narration holds its last frame, so it's redone only with a
    whole-video revision.
  - Fonts, shared classes and colour roles are frozen too. A redone scene may restyle itself, never the rest of the
    video.
- **Credits:** it's an agent run, so it costs about what a revision does, sometimes more. In our tests it cost 50–67
  credits per run, against 36 for a whole-video revision of the same request. You pay for the guarantee that the
  rest stays as it was, not for a discount.

**Where to find it:**

- On a video's page, **Revise** has **Whole video** and **Some scenes**: the version's scenes are chips with their
  times.
- On a pinned comment, **Redo this part** (owners and admins) opens the same choice with that comment's scene picked.
- **Incorporate feedback** offers **Only change the scenes these comments point at** when every comment you pick is
  pinned.
- History shows what each scoped version redid ("Redid Features").

From scripts, list a version's scenes with `GET /api/v1/videos/{id}/versions/{n}/beats` (or read `beats` on the
version), then `POST /api/v1/videos/{id}/versions` with `{"prompt": "…", "fromVersion": n, "scope": {"beats": ["demo"]}}`.
A version that can't be redone scene by scene answers `409 not_editable`. `/api/v1/config` lists `scoped_revision`
when the deployment supports it. From AI tools, pass `beats` (with `from_version`) to the `revise_video` MCP tool.
`get_video` lists each version's scenes. From the SDK:

```ts
await va.videos.redoScenes(id, { beats: ['demo'], prompt: 'Show the preview URL' }) // from the latest ready version
```

From the CLI, a scene is its id or its label:

```sh
video-agent scenes vid_…                                   # ids, labels and times
video-agent redo vid_… --scene demo "Show the preview URL" --wait
video-agent revise vid_… --scene Opening --scene outro "Brighter" --from-version 2
video-agent local revise ./videos/webhooks-launch --scene demo "Show the preview URL"   # on your machine
```
