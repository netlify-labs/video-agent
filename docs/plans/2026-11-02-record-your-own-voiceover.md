# Record your own voice-over — plan

- **Status:** draft 3 (2026-11-02). Folds in review rounds 1 and 2 (Fable 5 high and Codex gpt-6.1-sol high each round; 690 + 1,260 credits). §14 lists what was taken and what was rejected, per round. Next: phase 0 spikes, run to the spike contract in §9. The architecture choices marked **[S10]**–**[S13]** are provisional until their spike reports numbers.
- **Owner decisions so far (2026-11-02 interview):**
  - **Recording:** a whole take first, then punch-in re-records over any range. It should feel like a video editor: recordings are clips on a Narration track that sits above Music.
  - **Re-render:** the user picks either a plain re-render (render-unchanged, visuals untouched) or "let the agent adapt", which may retime scenes to fit the narration.
  - **Captions:** recorded narration is auto-transcribed into timed captions and VTT.
  - **In scope for v1:** a mic level meter, device picker and countdown; audio cleanup; uploading an existing file instead of recording; and an option to keep the original AI voice-over or sound under the narration.
- **Builds on:**
  - [`2026-10-31-storyboard-editor-feedback-media.md`](2026-10-31-storyboard-editor-feedback-media.md): editor, drafts, render-unchanged, media, trust model.
  - [`2026-11-01-ideas-audio-skills-oauth.md`](2026-11-01-ideas-audio-skills-oauth.md): sound, music, AI voice-over.
  - `docs/spikes.md` S2, S4, S5, S7 and S9.

---

## 1. Goal and why

Today a video's narration can only come from the AI: Kokoro in the run, or ElevenLabs when a key is set. People want their own voice on their own product videos. It sounds like them, it carries a demo better, and it removes the "AI voice" feel from anything that ships externally.

The feature: **press Record, watch your video play, talk over it, and get a new version with your voice mixed in, ducked music, cleaned-up audio and real captions.** If a sentence comes out wrong, re-record just that sentence. If the narration runs long, either keep the visuals (and trim or hold the last frame) or let the agent stretch the scenes to fit.

Success looks like this:
1. A creator narrates a 60–90 s video in one sitting, fixes two flubs with punch-ins, and renders, all in under 10 minutes. The keep-visuals render costs a fraction of an authoring run; the measured range is an S11/S12 output, and today's render-unchanged run is about 34 credits for 16–60 s videos.
2. **Sync:** narration lands within one video frame (≤ 33 ms at 30 fps) of where the speaker saw it, on the setups S10 qualifies. Other setups are "best effort with calibration", and the UI says so.
3. **Delivered audio**, measured on the decoded final AAC: −14 ± 1 LUFS integrated for non-silent mixes, true peak ≤ −1 dBTP, speech intelligible over the ducked music.
4. **Captions** follow the words, within the timestamp error S11 measures.
5. **Recordings are private:** raw recordings are readable only by their uploader and admins. Viewers get the rendered mix, never the source takes, and unused recordings are actually deleted (§8).

Non-goals for v1:
- Multi-person or remote recording.
- Camera or picture-in-picture.
- Voice effects.
- Real-time collaborative timeline editing.
- Mobile recording (untested, unpromised).
- Browser-side MP4 rendering. S7 rejected it, and rendering stays in the Agent Runner run.
- Take alternatives and a takes switcher (deferred to phase 6).

## 2. User workflows

### 2.1 Record a whole take
1. On a finished version, the user opens **Edit → Narration**, or clicks **Record voice-over** on the Video page, which opens the editor on the Narration track.
2. **Setup panel:**
   - **Mic picker** (`enumerateDevices`, remembered per browser) with a live input meter. A 3 s "check level" pass reports too quiet (< −40 dBFS RMS), OK, or clipping (≥ −1 dBFS peak).
   - **Output setup:**
     - *Headphones* (default): the monitor mix (§5.3) plays while recording.
     - *Speakers*: the monitor mix is muted or ducked to −30 dB while recording, and browser echo cancellation turns on.
     - The mode is fixed for the whole take.
   - **Calibration:** a per-route procedure that S10 must show works with headphones on (§5.3), prompted on the first take with a new route (input + output device + sample rate). A manual **Sync offset ±** slider is always available in preview. Bluetooth isn't detected or blocked; the calibration prompt and a copy line ("Bluetooth adds delay and lowers mic quality; wired is best") cover it.
   - **Original audio:**
     - *Replace AI voice-over* (default): the AI voice isn't played in the monitor and is muted in the render, but kept so it can be restored.
     - *Keep it under my voice*: the AI voice at a chosen level, −12 dB by default.
     - *Mute all original audio*.
3. The user clicks **Record**. This click is the user gesture that starts the `AudioContext` and playback (`resume()` is explicit). A 3-2-1 countdown plays while the mic is already capturing, so nothing is clipped, then the video plays from the start.
4. **Stopping:**
   - **Space** stops and keeps the take; **Esc** discards it.
   - Seeking, a playback stall, the tab going hidden, a device change (`devicechange`, mic track `ended`), a context interruption, or sync residual beyond the limit (§5.3) **stops the take and keeps what was captured** up to that point, with a message saying why.
5. The take appears as a clip on the **Narration** track, with its waveform, at the video time it was recorded against.
6. **Audition the mix** right away in the browser (§5.4). The narration is labelled *raw, before cleanup*. No render is needed.

### 2.2 Punch-in (re-record a range)
1. Select a range on the ruler, or put the playhead somewhere and press **R**.
2. **Pre-roll:** playback starts 2 s before the punch point (configurable 0–5 s), with existing narration audible so the user can match tone. At the punch point the monitor mutes the user's existing narration in the punch range. This is possible because the monitor is built from separate stems (§5.3).
3. **Recording:** capture runs continuously from the countdown. Only the samples from the punch range (or from the punch point until stop) become the new clip, and the full capture is kept as that take's source.
4. **Overlap:** the new clip is laid on top. Older clips are trimmed or split non-destructively, and their source audio is never modified. Each edit point gets a fixed 20 ms crossfade using handle audio where both sides have it, or edge fades where they don't.

### 2.3 Arrange clips like an editor
- **Clip actions:**
  - Drag clips in time.
  - Trim either edge. Trimming moves the source bounds, which is non-destructive.
  - Split at the playhead (**S**) and delete (**Del** / **Backspace**).
  - Set clip gain (−∞ to +12 dB) and fades.
- **Tracks:** each one has volume and mute, and Narration also has solo.
  - **Scenes:** read-only lane showing beat boundaries.
  - **Narration:** the user's clips.
  - **AI voice:** the existing per-beat clips.
  - **Music:** with a duck toggle and amount.
- **Snapping:** to beat boundaries, other clip edges and the playhead. Hold ⌥ / Alt to disable it.
- **Zoom:** ⌘/Ctrl-scroll.
- **Undo/redo** is a local command stack in the editor. Draft saves keep only the newest revision (`edits.ts:208`), so undo can't come from server revisions.
- **Keyboard shortcuts** ignore focus inside text fields and have Ctrl equivalents on non-Mac.
- **Recordings** are managed with the library's existing conventions: `title` and notes (`db/schema.ts:305-307`), and the table view (`ui/src/pages/Media.tsx`) with a *Recordings* filter.

### 2.4 Upload instead of record
- Drag an audio file onto the Narration track, or pick one from the library.
  - Accepted formats: MP3, WAV, M4A and Ogg today; WebM/Opus once §5.2 lands.
  - It lands at the drop position (default 0) and the user aligns it by dragging.
- **Library audio used as narration keeps its license and attribution** (§6.1).
- **Auto-align against the AI voice track** is deferred (phase 6).

### 2.5 Render
The user clicks **Render**. A dialog shows a duration and overflow preview (where narration starts and ends against the video) and the cost range for each option:

- **Keep my visuals (preselected).** This is render-unchanged.
  - Narration plays over the existing scenes. Visual frames are identical to the frozen edited draft (§10 checks this).
  - **If narration runs past the end**, the user chooses:
    - trim the clip;
    - **hold the final frame** for the overrun plus a 0.5 s post-roll. This is a deterministic append of a still of the last frame, bounded by the output-duration limit (§6.1). It doesn't stretch the last beat's animation.
    - switch to the fit option.
- **Let the agent fit the video to my narration (≈ an authoring run, about 250 credits).**
  - An authoring run from the **frozen edited draft** (§6.4).
  - The agent gets the narration's word timings (or, if transcription failed, duration-only guidance) and an exact target duration. It may retime, extend or tighten scenes to match.
  - **The agent cannot change the narration audio.** A guard enforces this (§6.4).

**The result is a new version n+1** with:
- mode `render_unchanged` or `author`, with provenance;
- narration-derived captions;
- the usual MP4, GIF, VTT and poster, plus `narration.mp3` and `transcript.txt`.

**Publication** is per version and unchanged.

### 2.6 Fix captions afterwards
- The transcript is shown as cues, and words can be corrected. Fixes keep their timings and only change the text.
- For VTT-sidecar captions (the default), a fix creates a **caption revision** of the version (§6.6): new immutable files, delivered through revision-aware signed paths, with **no render**.
- For burned-in captions (a stored per-version policy), fixes go through the editor and a render-unchanged run.
- Ships with the first recording release.

## 3. Constraints from the current system

Verified at `8649997`. Line numbers are as of that commit.

| Fact | Where | Consequence |
|---|---|---|
| **Rendering and cost.** Every MP4 renders in an Agent Runner run; there's no function-side or browser render (S7). Render-unchanged has cost 33.6–34.4 credits, measured only on 16 s and 60 s videos. render-job's own render timeout is 20 min, inside a 22-min authoring and 25-min runner limit. | `render-job.ts:114-116`, `prompt.ts:312-366`, `docs/spikes.md:164-175,197-217` | Keep-visuals is a render-unchanged run. The **whole** hydrate → clean → STT → render → upload sequence must fit the budget, and long videos need measuring (S11/S12). |
| **Modes and restore.** Version modes are `author` and `render_unchanged`; `RunKind` is `author`, `revision` or `render_unchanged`. Only render-unchanged consumes `version.frozen`. An author run with a parent restores the **parent's** `source.tar.gz`. `FrozenBundle` carries `editId`. The run manifest serializes its fields explicitly. | `types.ts:260-270`, `run-manifest.ts:9,64`, `reconciler.ts:167-205` | Fit mode needs a new run kind plus manifest, reconciler and prepare-run changes together (§6.4). |
| **Layers.** `validate()` requires every `data-va-layer` to be on track ≥ 1 and span the video. `relayout()` resets every layer to start 0 and full duration on each `applyEdits` and `applyRevoice`, then calls `applyDucking`. | `contract.ts:337-347,569-573` | Use one full-duration narration bus; per-clip layers are illegal. |
| **Audio roles.** `AUDIO_ROLES = ['music','voice','sfx']`; any other `data-va-audio` value fails validation. The DTO enum also excludes narration. | `contract.ts:236,423-425`, `schemas.ts:753` | Add a `narration` role everywhere it's enumerated (§6.2). |
| **Ducking.** `duckPoints` derives dips only from beat voices (muted voices included) and `validate()` checks the lane against it with `sameLane` tolerance. `data-va-duck` marks the *recipient*. | `contract.ts:403-410,468-526` | `duckPoints` changes in shared code: add narration spans, exclude muted voice (§6.3). |
| **Mute.** Mute is `data-volume="0"` plus `data-va-muted`, with the level in `data-va-volume`. HyperFrames mixes every timed `<audio>` regardless of `muted`. | `contract.ts:696-718` | AI-voice *replace* reuses this exactly. |
| **HyperFrames 0.8.222 audio.** Attributes `data-start`, `data-duration`, `data-volume`, `data-media-start` (overridden by `data-playback-start`) and `data-automation` (clip-local, multiplies gain). Native `loop`. Video elements' audio, groups and effects are part of the mix. It already measures decoded-AAC true peak and applies bounded attenuation. An automation point cap of about 512 was reported by one reviewer and couldn't be found by the other. | `node_modules/hyperframes/dist` | Mastering reuses HyperFrames' peak enforcement. The guard covers the effective audio graph. Automation is kept ≤ 400 points, and S12 confirms any cap. |
| **Captions.** `validate()` needs `beat`+`textId` or `voice: true` on a voiced beat. `syncVoice` rewrites voice captions. `captions.vtt` is a required output. | `contract.ts:435-452`, `scripts/voice.ts:145-173`, `types.ts:781-787`, `finalize.ts:141` | Narration needs its own cue kind, and failure writes an empty valid VTT (§6.6). |
| **Signed file paths.** Private file URLs are signed for fixed filenames, and the files edge function matches a fixed filename regex, builds the Blob key from the path, and caches `private, immutable`. | `src/domain/files.ts:44`, `netlify/edge-functions/files.ts:18,37-47` | Caption revisions need revision-aware paths (§6.6). |
| **Bundles.** `excluded()` only skips library media (`assets/media/med_*`), so every other file goes into `source.tar.gz`, checkpoints and **preview bundles that version readers can open**. Bundle tar limits: 10 MiB per file, 50 MiB total. | `bundle-manifest.ts:24-28`, `run-tools.ts:22-30`, `bundles.ts:107-122`, `edge-functions/preview.ts:77-99`, `tar.ts:12-16` | Raw takes must never enter `video/`. A 24 kHz PCM16 bus passes 10 MiB at about 218 s, so the bus is stored by reference, not in the tar (§6.2). |
| **Audio sniffing.** MP3, PCM WAV, Ogg Vorbis/Opus, M4A/AAC; WebM rejected; 50 MiB / 600 s limits. | `classify.ts:34-54,124-166`, `audio.ts:208-214` | Recordings upload as 24 kHz PCM16 WAV. WebM is upload-only (§5.2). |
| **Uploads.** Sessions use 4 MiB parts with a 100 MiB ceiling. The uploader hashes the **whole file in memory** (`await f.arrayBuffer()`). Completion can return before the media is ready. The 1 GiB quota counts unfinished uploads only. | `upload.ts:93-158`, `media-uploads.ts:14-57`, `store/drizzle.ts:516-523` | The worker supplies the hash. Ready-wait before treating a take as saved. Add a stored-bytes quota for takes. |
| **Media access.** Snapshots are capped at 12 items / 300 MiB and hydrate by Blobs key + sha256. `loadMedia` lets any signed-in reader load any ready media. `checkMedia` duplicate lookup returns matches across the library. Delete is soft. There is **no media GC**. Usage and credits read `version_media` only, and count audio as audible only via `sound` or `voiceover`. | `media.ts:155-159,252-258,277-286,306-353`, `prepare-run.ts:184-199`, `store/drizzle.ts:440,484-501,704-731`, `credits.ts:76-85`, `cleanup.ts` | Takes need a separate snapshot list, one authorization predicate on every path, a reference index, GC and provenance (§6.1, §8). |
| **Drafts.** Author-only. Expire after 7 days. Only the newest revision is kept. Save locks the edit row, but media lookup happens outside that transaction. | `edits.ts:29,160,208,265,282-301` | Reviewers hear committed versions only. GC needs a lock protocol (§8). |
| **Preview and players.** The preview iframe is `sandbox="allow-scripts"` (opaque origin, its own time origin). The bridge sends `ready`, `time` (when moved > 20 ms), `click`, `error` and `edits-applied`. The Video page plays the mixed MP4 (one AAC track) in a native `<video>`. | `CompositionPreview.tsx:235`, `bridge.js`, `Review.tsx:111-123` | Record against the MP4 **muted** as a picture reference, and build the monitor mix from separate stems (§5.3). |
| **Edits that move time.** A voice-only edit can lengthen beats and shift later visuals. | `contract.ts:774` | Any pending op that changes timing blocks recording, not just "visual" ops (§5.3). |
| **STT.** No STT on the AI Gateway. `hyperframes transcribe` fails with `whisper_unavailable` and suggests Parakeet. The transcribe timeout option applies to Whisper only. | `docs/spikes.md:229-249`, HyperFrames transcribe | S11 needs an outer process-tree deadline (§6.6). |
| **Output duration.** There's no global output-duration limit; create takes any positive duration. | `schemas.ts:332-337` | Define one for narration placement and hold-frame (§6.1). |
| **Mic policy.** No `Permissions-Policy` anywhere. `netlify.toml` covers static responses, and share and embed pages are edge responses. | `netlify.toml:34`, `netlify/edge-functions/*` | Set the mic policy in both places (§8). |

## 4. Architecture overview

```
Browser (editor)                                   Functions / DB / Blobs                      Agent Runner run
────────────────                                   ──────────────────────                      ────────────────
Recorder: AudioWorklet → worker (24k PCM16 WAV,     upload session (worker hash) → media{audio,
  hash, peaks) → IndexedDB from chunk 1 ──────────▶   role, scope} + peaks blob; ready-wait
Picture: base MP4, muted, rVFC anchors              one authorization predicate (read, link,
Monitor: draft stems (music, AI voice, narration)     duplicates, search, ops, snapshots)
  in parent Web Audio on the same clock [S10]       media_refs index + lock protocol + GC
Timeline (src/lib/timeline.ts, integer samples) ──▶ saveEdit: narration op → buildRev
  local undo                                          (speech spans from peaks → duck lane)
                                         Render ──▶ renderEdit: freeze editId + recipe
                                                      (takes, settings, target duration) ───▶ prepare-run: takes → run-input
                                                                                                 dir OUTSIDE video/ (never archived)
                                                                                               revoice (if any) → narration.ts:
                                                                                                 clean → mix bus (target length)
                                                                                                 → receipt; bus by reference
                                                                                               STT (outer deadline, cached)
                                                                                               [fit: author run sees bus + words]
                                                                                               checkNarration / narration_modified
                                                                                               render → master/measure → finalize
```

What goes where, and why:
- **Recording happens in the browser.** Only the browser has the mic. PCM through an AudioWorklet gives per-sample positions, while MediaRecorder has codec delay, opaque timing and WebM output. S10 compares the two and keeps the winner.
- **One clock for recording.** The base MP4 plays muted in the parent document as the **picture**, and `requestVideoFrameCallback` gives presented-frame times on the parent clock. The **monitor mix** is the draft's separate stems scheduled with Web Audio on that same clock. That's what makes *replace* and punch-in muting work.
- **The timeline is a whole-track snapshot op** on the existing draft system. Undo is local.
- **One narration bus per render, stored by reference.** The composition carries one full-duration narration layer; its WAV lives in Blobs with a digest in the manifest, outside the 10 MiB tar limit. Raw takes never enter `video/`, archives or previews.
- **Deterministic processing in the run** (`scripts/narration.ts`, invoked and never edited by the agent) produces a receipt bound to the attempt. Guards check the composition against frozen-derived expectations plus that receipt.

## 5. Browser: recording, sync and preview

### 5.1 Recorder
- **Mic stream:** `getUserMedia({ audio: { deviceId, channelCount: 1, echoCancellation: <speakers mode>, noiseSuppression: false, autoGainControl: false } })`. Stop the mic tracks when leaving the editor or cancelling.
- **Capture chain:** `AudioContext` → `MediaStreamAudioSourceNode` → `AudioWorkletNode('va-recorder')`.
  - The worklet's output is silent (not connected, or through a 0-gain node).
  - It posts **transferable** Float32 blocks with their context sample index to a **Worker**.
- **Worker** (bounded memory):
  - streams the resample to 24 kHz and encodes PCM16;
  - computes multiresolution peaks and the speech-span summary (§6.2);
  - hashes incrementally;
  - writes every chunk to **IndexedDB from the first chunk**.
- **Upload:** the worker's final hash is passed into the upload session, so the uploader never calls `arrayBuffer()` on the whole file. That needs a small `uploadFile` option. Resume state is bound to user, role and scope.
- **Recovery record:** recording UUID, sample sequence, clock anchors and fit, device route, draft id + `expectedRev`, and upload state.
  - On reload, offer to recover takes that are unsaved or not yet uploaded.
  - The local copy is kept until the media is **ready** and the draft save that references it has succeeded.
  - Quota errors stop the take cleanly.
  - Records belong to the user id and are never offered to another account.
  - Recovery copies are cleared on ready + save, on discard, or after 7 days.
- **Level meter:** an `AnalyserNode` showing RMS and peak, with a latched clip indicator.
- **Mic denied or missing:** an empty state with retry and help. Upload stays available.

### 5.2 Upload instead of record
- Reuse upload sessions with `role: 'narration-upload'`.
- **WebM/Opus:** parse EBML structurally. Accept one audio track (`A_OPUS`/`A_VORBIS`) and reject video tracks. Bound duration, channels and decode work. ffprobe re-checks it in prepare-run. Fixture in `media.test.ts`.

### 5.3 Picture, monitor and sync clock [S10]
- **Picture:** while armed, the editor shows the base version's MP4 in a parent-document `<video muted>`.
  - It's the visual reference only.
  - `requestVideoFrameCallback` gives `(mediaTime, expectedDisplayTime)` for every presented frame on the parent's `performance.now()` clock.
- **Monitor mix:** the parent schedules the draft's separate audio stems with Web Audio in **one `AudioContext`**, positioned from the picture anchors:
  - music (with the draft's volume and duck);
  - AI voice WAVs in *keep* and *under* modes (none in *replace*);
  - the user's existing narration clips (muted inside an armed punch range).

  The stems come from the edited draft bundle through the existing preview routes, which are author-only for drafts. Narration takes come through scoped signed links.
- **Recording is blocked while any pending op changes timing:** retime, reorder, delete, **and voice ops that change beat length** (`contract.ts:774`). The message is "render or discard timing changes first". Audio-only ops that don't move time (music volume or mute) are allowed, and the monitor reflects them.
- **Fit:** anchors give `(composition time, perf time)` pairs. Worklet blocks give `(context sample, context time)`. `getOutputTimestamp()` maps context time to perf time where available (feature-detected, never with `outputLatency` added on top).
  - Fit `t = a + b·sample` over the take and store the **whole fit** (`a`, `b`, residual RMS, max residual) plus calibration and manual offsets. Never collapse it to a single offset.
  - If the slope deviates from 1/sampleRate by more than S10's tolerance, or the cumulative residual exceeds a limit (default 10 ms), the take stops there and keeps the clean part.
- **Input-to-picture latency** comes from calibration, because mic input latency isn't reliably reported. **S10 must demonstrate a headphone-compatible procedure.** Candidates:
  - (a) a measured input-latency loopback done once on speakers, with output latency taken from `getOutputTimestamp()`;
  - (b) a clap-on-flash test, where the user claps when a visual flash appears; it measures the whole perceive-and-react path, averaged over 8 claps with outliers dropped;
  - (c) manual offset only.

  S10 picks the default from measured repeatability. Calibration is keyed to the route and invalidated when the route changes.
- **The tab must stay visible.** Hiding it stops the take.
- **No iframe recording fallback in v1.** It gets added only if S10 shows MP4 mode failing on a supported browser.

### 5.4 Audition (post-record mix preview)
- **Visuals:** the composition preview iframe, which reflects the draft.
- **Narration:** parent Web Audio plays the raw clips with the shared `src/lib/timeline.ts` crossfade and gain math.
- **Mix control:** a new bridge command, `mix{tracks}`, sets track volumes and mutes on the iframe's `<audio>` elements. Ducking imports the shared `duckPoints`.
- **It's labelled raw.** Cleanup exists only in the run, so the preview doesn't promise processed-audio parity.
- **Decode budget:** a sliding window around the playhead, with a 200 MB budget across takes and an LRU cache. Takes are never all decoded at once; 32 ten-minute takes would be about 1.8 GB. Waveforms come from the stored peaks.

### 5.5 Timeline UI
- **Location:** `ui/src/components/timeline/`. DOM lanes first (four of them); canvas only if profiling needs it.
- **Model:** `src/lib/timeline.ts` is pure TypeScript shared by the UI and the server. It resolves overlaps, works in integer samples, quantizes visuals only, and does gain and fade math. Undo is a reducer.
- **Keyboard shortcuts:**
  - Space: play/pause
  - R: record or punch
  - S: split
  - Del / Backspace: delete
  - ⌘Z / Ctrl+Z: undo; ⇧⌘Z / Ctrl+Y: redo
  - ←/→: nudge one frame; ⇧ nudges 10 frames
  - All shortcuts ignore input fields.
- **Accessibility:** clip menus, focusable clips that move with the arrow keys, and an `aria-live` recorder state.

## 6. Server and run: data, contract, render

### 6.1 Data model
- **Takes are media rows** (`kind: 'audio'`) with **queryable** columns:
  - `role: 'narration-take' | 'narration-upload' | null`
  - `scope_job_id`
  - `retain_until`
  - `state` (adds `deleting`)
  - an index on `(uploader_id, role)`

  `meta.json` keeps sampleRate, duration in samples, the sync fit and a hashed device label. Peaks live in `<id>/peaks.bin` (multiresolution Int8, about 60 KB for 10 min).
- **Reference index (new table `media_refs`):** `(media_id, owner_kind, owner_id)`, where `owner_kind` is `draft`, `frozen_attempt` or `version`. It's written in the same transaction as the reference (§8). GC, usage, credits and scope checks all read it.
- **Edit op: one whole-track snapshot**, matching the full-op-list save model (`edits.ts:279-304`):
  ```ts
  type NarrationOp = {
    op: 'narration'
    schema: 1
    sampleRate: 24000                         // all source coordinates are integer samples at this rate
    clips: Array<{
      id: string                              // stable slot id
      mediaId: string
      srcStart: number                        // integer samples into the source
      srcEnd: number                          // > srcStart
      fit: { a: number; b: number; residualMs: number }   // recording alignment (identity for uploads)
      offsetSamples: number                   // calibration + manual offset
      start: number                           // composition position, integer samples
      gainDb: number | null                   // finite -60..+12; null = silent
      fadeInSamples: number                   // 0..min(len/2, 2 s)
      fadeOutSamples: number
    }>
    tracks: {
      narration: { volumeDb: number; muted: boolean; solo: boolean }
      aiVoice:   { mode: 'replace' | 'under' | 'keep'; volumeDb: number }
      music:     { duck: boolean; duckDb: number }
      original:  { muteAll: boolean }
    }
    cleanup: 'off' | 'light'                  // 'heavy' (RNNoise, declick) deferred
  }
  ```
  Crossfade length (20 ms) and duck release-after-pause (1,500 ms) are **constants** in `timeline.ts`, not fields. They can become fields in schema 2.
- **Validation** (zod in `src/schemas.ts`, plus server-side `timeline.resolve()`):
  - Resolved clips don't overlap.
  - Every number is finite, and source bounds fit the take.
  - At most 200 clips and 32 distinct takes per op.
  - **Output-duration limit:** the last clip end (or hold-frame end) is at most the base duration + 120 s, and never over 15 min total. This is a new explicit limit, since none exists today.
  - Every `mediaId` passes the authorization predicate (§8). New picks are checked against the current user. Inherited references (the base version's frozen narration) stay valid through soft-delete or ownership change, because the version owns them through `media_refs`.
- **Version fields:**
  - `versions.voiceover` stays as the AI synthesis configuration.
  - New `versions.narration jsonb`, nullable: the resolved op, the recipe (pipeline version, ffmpeg version string, settings) and the bus reference `{key, sha256, samples}`.
  - The AI / recorded / mixed badge is derived from the audible tracks.
  - New `versions.captions jsonb`: `{status, policy: 'sidecar' | 'burned', rev, files: {vtt, transcript}, sha256}`. It's separate from the render's output hashes (§6.6).
  - Migration generated with `npm run db:generate` (new migration only).
- **Snapshots and provenance:**
  - `renderEdit` writes `frozen.narration = {op, takes: [{mediaId, key, sha256, bytes, license?}], recipe, targetSamples}`, capped at 32 takes / 400 MiB, and adds `media_refs` rows of kind `frozen_attempt`.
  - On finalize, those become `version` refs.
  - **Library audio used as narration** carries its license and attribution into the snapshot.
  - Usage and credits union `media_refs` narration references with `version_media`, and audibility is derived from the resolved mix (`credits.ts:76-85` changes).
- **Draft expiry:** the narration op dies with the draft; takes survive (`retain_until`) and are listed under **Recordings for this video** for re-attach.

### 6.2 Contract and bus storage
- **Audio role:** add `'narration'` to `AUDIO_ROLES` (`contract.ts:236`), the `AudioRole` type, `audioOf()`, the DTO enum (`schemas.ts:753`) and the editor's track mapping, all in one change.
- **The composition carries exactly one narration layer:**
  ```html
  <audio id="va-narration" data-va-layer="narration" data-va-audio="narration"
         data-track-index="4" data-start="0" data-duration="<root>" data-volume="1"
         data-va-speech='[[12.48,15.69],…]' src="assets/narration/bus.wav"></audio>
  ```
- **Draft vs materialized state:**
  - **In a draft** (`buildRev`), the element is written with `data-va-speech` computed **from the op plus each take's stored speech-span summary** (worker VAD on peaks), and with **no `src` file present**. The editor auditions from the op (§5.4) and never needs the bus. Every save recomputes the spans, so `relayout()`/`applyDucking` always see current spans, and the duck lane validates in draft previews.
  - **In the run,** `scripts/narration.ts` materializes `bus.wav` at exactly the **frozen target length** (§6.3, §6.4) and rewrites `data-va-speech` from the processed bus. The guard checks both.
- **Bus storage by reference:**
  - The bus is uploaded to Blobs (`videos/<job>/v<n>/narration-bus.wav`) with its digest in the bundle manifest.
  - `assets/narration/bus.wav` is listed in the manifest as a **reference entry**: excluded from `source.tar.gz`, checkpoints and the 10 MiB tar limit, and restored by key + sha256.
  - Preview delivers it through a version-scoped route with the same access as the version's MP4.
  - `excluded()` (`bundle-manifest.ts:28`) learns these reference entries.
- **Narration validator:**
  - one element at most, with `src` = `assets/narration/bus.wav`;
  - in materialized state, the referenced file's sample count equals the root duration;
  - in draft state, no file is present.
- **Fit mode and duration:** the bus is mixed once at the frozen target length, and the narration validator fails until the beats total exactly that frame-quantized length. The prompt states it, and the run's final check enforces it.
- **AI voice modes** reuse the existing mute semantics: *replace* mutes, *under* sets the level, *keep* leaves it unchanged.
- **No per-clip attributes** go into HTML.

### 6.3 Processing, ducking, mastering and the keep-visuals render
**Run inputs:** prepare-run hydrates takes from `frozen.narration.takes` (Blobs key + sha256) into a **run-input directory outside `video/`** (`.va-run/narration/src/`). It's never archived, checkpointed or previewed. Revoice, if present, runs first (§6.3 ordering).

**`scripts/narration.ts`** is deterministic and versioned with `NARRATION_PIPELINE = 1`. ffmpeg is invoked with `-threads 1 -filter_threads 1`, and the ffmpeg version is recorded in the receipt.

1. **Verify inputs.** ffprobe each take: 24 kHz mono PCM16 for recordings; uploads are decoded to that.
2. **Clean each take** (`light`, or `off` = a true bypass). The chain preserves sample count, so there's no time-stretch and no trim:
   1. `highpass=f=80`;
   2. `afftdn` with conservative noise reduction;
   3. a gentle de-esser;
   4. a compressor at 2:1 with threshold −24 dBFS, attack 10 ms, release 120 ms and a soft knee;
   5. **per-take gain** toward a speech target, from gated integrated loudness of speech regions. Silence-only takes get no gain and a warning.

   S13 tunes these defaults.
3. **Mix the bus** at the frozen target length with `src/lib/timeline.ts` math. The bus is pre-limited at −2 dBTP.
4. **Speech spans and duck.** Write `data-va-speech` from the processed bus (VAD), merged with the 1,500 ms release rule.
   - `duckPoints` (`contract.ts:468-491`) is extended in shared code: its sources are beat voices that **aren't muted** and the narration spans.
   - Automation is simplified to ≤ 400 points.
   - `validate()` keeps checking the lane.
5. **Receipt.** Write `.va-run/narration/receipt.json` with:
   - the input take hashes;
   - the recipe;
   - the bus sha256 and sample count;
   - the spans;
   - the attempt id.

   The guard reads the receipt instead of redoing cleanup, which avoids doubling CPU time.
   - **Trust boundary:** the same as revoice today. The runner is the trust model's boundary (2026-10-31 plan, "Roles and privacy (R)", rule 5). The guard protects against accidental agent edits, not a hostile runner.
   - Hash equality within a run is the guarantee. Equality across runs is best-effort and is only used for caches.
6. **Transcribe** (§6.6), with an outer deadline. It never blocks the render.
7. **Render, then master and measure.** After `hyperframes render`, which already enforces AAC true peak with bounded attenuation, decode the final AAC and measure with `ebur128`.
   - **Mastering is a trusted final-mix transform separate from the locked narration PCM.** It's one master gain applied to the **summed mix**: every audible source, including video-element audio, groups and effects. It's applied as a re-mux of the audio stream, not by editing HTML volumes, so the guard's exact-transform check isn't violated.
   - Target −14 ± 1 LUFS integrated, bounded by −1 dBTP. If both can't be met, peak wins and the measured LUFS is recorded with a warning.
   - Silent or near-silent mixes are exempt.
   - **Any HyperFrames degraded-automation warning fails the run.**
   - S12 confirms the re-mux path.

**Keep-visuals guard (`checkNarration`, modelled on `checkRevoiced`, `revoice.ts:71-135`):**
- `renderEdit` freezes `editId` (the edited draft bundle), `frozen.narration` (op, takes, recipe, `targetSamples` = base duration, or base + hold-frame), and the caption policy.
- render-job checks, from frozen inputs plus the receipt:
  1. `index.html` = frozen + exactly the narration transformation (element, spans, duck lane, AI-voice mute attributes, optional hold-frame beat `data-va-hold`);
  2. `bus.wav` digest and sample count = receipt;
  3. `summary.json` = frozen + narration cues;
  4. every other `video/` file is byte-identical;
  5. nothing from `.va-run/` is under `video/`.
- **Ordering:** revoice (`voice.ts revoice` + `checkRevoiced`) runs first, then narration. One function in `src/lib/narration-run.ts` defines the order and is used by both the prompt and the guards.

### 6.4 Fit-to-narration render
- **New run kind `author_from_frozen`:**
  - `RunKind` (`run-manifest.ts:9`) gains it.
  - The manifest serializer and verifier (`run-manifest.ts:64`) carry `bundle` + `narration` for it.
  - The reconciler (`reconciler.ts:167-205`) restores the **frozen edited draft** (`frozen.editId`) instead of the parent archive.
  - prepare-run preserves guard baselines for narration as it does for revoice (`prepare-run.ts:166-179`).
  - All four change together, with one test per pair.
  - Version mode stays `author`, with provenance `editedFromN`.
  - The API and MCP refuse fit mode when there's no narration op.
- **Frozen:** the edited draft, the recipe, and the **target duration** (narration end + 0.5 s post-roll, frame-quantized, within the output limit).
- **Order before the agent:**
  1. restore and verify;
  2. revoice, if any;
  3. `narration.ts` steps 1–5 (a bus at target length, plus the receipt);
  4. STT (§6.6, bounded).
  5. Then the agent authors.
- **Prompt:**
  - Narration is locked.
  - `voiceLines` TTS instructions (`prompt.ts:284-307`) are suppressed in *replace* mode.
  - The transcript is passed as fenced, sanitized data, following the existing prompt conventions.
  - The agent must make beats total exactly the target duration.
  - If STT failed: duration-only guidance, plus a status shown to the user.
- **Guard (`narration_modified`):** expected values come from the frozen inputs and the receipt, never from agent-written files. render-job verifies:
  - exactly one narration element, with its full attribute set as expected;
  - the bus digest = receipt;
  - no added or removed narration-role audio;
  - no new `<audio>` or `<video>` with audio that overlaps the speech spans, unless it was frozen;
  - no effect, automation or volume change on the narration element or on any group or master path that reaches it. The **effective audio graph** is checked.
- **Locks persist** through retries and later revisions, until the user edits narration.
- Cost: an authoring run, about 250 credits, confirmed in the dialog.

### 6.5 Why processing is deterministic code, not prompt
- Narration quality is the point of the feature.
- Cleanup, mixing, ducking and mastering are one versioned script with fixed parameters, fixture tests and measured output. The agent only runs it.
- Both render modes use the same script, so they sound the same.

### 6.6 Captions [S11]
- **Provider:**
  - **Local first:** Parakeet (`hyperframes models install parakeet` + `hyperframes transcribe`) if S11 qualifies it, otherwise whisper.cpp (pinned binary, model digest and license, parsed JSON word timings).
  - ElevenLabs Scribe is opt-in only, a separate setting from the TTS key.
  - `transcriptionProvider: 'local' | 'elevenlabs' | 'off'`, default `local`.
- **Budget:**
  - STT runs from a 16 kHz decode of `bus.wav`.
  - It's wrapped in an **outer process-tree deadline**, covering install, model download and transcription, because the HyperFrames timeout option only applies to Whisper. On timeout the process tree is killed.
  - The whole sequence must fit inside 22 minutes, measured in S11.
  - Results are cached by `(bus sha256, provider, model, language)`. A cache miss after a runner-image change just re-transcribes.
- **Cues:**
  - A new cue kind `narration: true` with absolute `start`/`end`, `text`, a stable `id` and `words[]`. It's exempt from the beat checks in `validate()`.
  - Grouping lives in `src/lib/narration-captions.ts`: 42 characters × 2 lines, split at pauses > 300 ms and at punctuation, 1–6 s per cue.
- **What's audible gets captioned:**
  - *replace*: narration cues only;
  - *under* / *keep*: narration and AI cues interleaved;
  - muted narration: no narration cues.
- **Failure:** write a valid empty `captions.vtt` (a required output) and set `versions.captions.status = 'failed' | 'off'`. The UI shows "No captions: retry or add them".
- **Caption revisions:**
  - `POST /api/v1/videos/:id/versions/:n/captions` takes `{expectedRev, cues}`, with compare-and-swap on `versions.captions.rev`.
  - It writes immutable `captions.r<k>.vtt` and `transcript.r<k>.txt`.
  - **Signed paths become revision-aware:** `src/domain/files.ts` signs the filename from `versions.captions.files`, and `netlify/edge-functions/files.ts` accepts `captions(?:\.r\d+)?\.vtt` and `transcript(?:\.r\d+)?\.txt`. Each revision is a new immutable URL, so `private, immutable` caching stays correct.
  - **Render hashes stay immutable.** Revision hashes live in `versions.captions`.
  - The video ETag is bumped.
  - It needs owner or admin, plus publish authority when published.
  - Burned-in policy (stored, not inferred from HTML) is refused here.
  - **Publication ordering:** the publication mirror carries a `captionsGeneration`. Updates are applied with compare-and-swap on it, after the DB commit, with durable retry. An older correction can never overwrite a newer one, and a correction after unpublish is a no-op.
  - **Carry-forward:** when a new version is made from version n and its narration op is **unchanged** (op hash), the latest caption revision is copied. Otherwise the new version is re-transcribed. This uses the op hash, not PCM hashes, so ffmpeg changes don't matter.
- **Language:** English in v1. Multilingual is phase 6.

### 6.7 Outputs
- **Files:** mp4, gif, poster, vtt, `narration.mp3` (192 kbps, the processed bus) and `transcript.txt`.
- **Publication:** they follow the version's publication.
- **Share-page transcript:** offered in the publish dialog with a preview. It's off by default for recorded narration, and the choice is remembered (§12.5).

## 7. API and MCP

- **REST changes**, documented in OpenAPI and checked by `openapi:check`:
  - Upload sessions accept `role`, `scopeJobId` and a client-supplied `sha256`.
  - `GET /api/v1/videos/:id/recordings` lists in-scope takes for that video.
  - `GET …/versions/:n/narration` returns the resolved op and the transcript.
  - `POST …/versions/:n/captions` creates a caption revision (§6.6).
  - Draft endpoints accept the `narration` op.
  - `renderEdit` gains `mode: 'keep_visuals' | 'fit_to_narration'` and `holdFinalFrame?`. The idempotency key includes the rev, the mode and the settings.
- **MCP** (phase 6): `get_narration`, `add_narration {mediaId, start}` (media ids only, no URL ingestion) and `render_with_narration {mode}`. Fit mode is refused without narration.
- **Skills:** a `narration.md` page.

## 8. Security, privacy, roles

- **Roles:**
  - Record, upload and render need Creator.
  - Drafts stay author-only (`edits.ts:265`). Reviewers hear committed versions.
- **One authorization predicate:** `canReadTake(principal, media)` is true for the uploader and admins only. It's enforced on every path that can expose a take, across REST and MCP:
  - `loadMedia` and signed links;
  - library and music search;
  - `checkMedia` duplicate lookup (`media.ts:252-258`), which must not reveal other users' takes;
  - op resolution;
  - snapshots;
  - upload finalization.

  Viewers of a version get the rendered MP4 and the bus-derived `narration.mp3`. They never get raw takes, and raw takes are never in archives or previews (§6.2, §6.3). Reusing shared library audio as narration doesn't change that item's existing access policy.
- **Runner trust model:** Creators' runs can read project storage (2026-10-31 plan, "Roles and privacy (R)", rule 5; the v1 trust model is an owner decision). Take privacy is enforced at the app layer; the setup docs say runs can read storage.
- **GC and the lock protocol (new):**
  - **Deletion predicate:** take bytes are deleted only when **no `media_refs` row exists** and retention allows it (`retain_until` passed, or the user chose **Delete unused recordings**). Soft delete stops new picks but never overrides retained references.
  - **Locking:** draft saves that add narration references, `renderEdit` freeze, attempt retries and GC all take `SELECT … FOR UPDATE` on the media rows involved, in media-id order, inside their transaction. Reference writers reject `state = 'deleting'`.
  - **Two phases:**
    1. GC commits `state = 'deleting'` plus a deletion work item atomically, after re-checking `media_refs` under the lock.
    2. Blob deletion (original, peaks and cached transcripts) runs outside the transaction, with retries.
  - Browser recovery copies are covered in §5.1.
- **Budgets:** a stored-bytes quota for takes (default 2 GiB per user) and an upload rate limit.
- **Mic policy:** `Permissions-Policy: microphone=(self)` on app routes (`netlify.toml`), and `microphone=()` set **in the edge functions** for share, embed and public pages. Both are header-checked live.
- **Disclosure:** docs state where recordings are stored, that runs can read storage, and that ElevenLabs transcription sends audio out.

## 9. Phases, spike contract and dependencies

The order is storage and privacy, then upload-to-render, then recording, then punch-in, then fit.

| Phase | Contents | Depends on | Live gate |
|---|---|---|---|
| **0: spikes** | See the spike contract below. | — | `docs/spikes.md` S10–S13 with numbers; draft 4 confirms or revises the [S] choices. |
| **1: storage + privacy** | Media columns + `media_refs` + migration; `canReadTake` on every path (incl. `checkMedia`, search, MCP); peaks blob; quota; lock protocol + two-phase GC; mic Permissions-Policy (static + edge); recordings endpoint. | 0 | A non-uploader gets 404 on a take everywhere, including duplicate lookup. A concurrent save and GC test keeps referenced bytes and deletes unreferenced ones. |
| **2: upload → render (keep visuals)** | Narration op; `timeline.ts`; audio role; draft spans; `narration.ts` + receipt; run-input dir; bus by reference; extended `duckPoints`; `checkNarration`; mastering re-mux; STT with outer deadline + cache; narration cues; empty-VTT fallback; caption revisions with signed paths, CAS and mirror generations; `narration.mp3`/transcript; hold-frame; provenance + credits. | 1 | Fixture WAV with known beeps and transcript, 3 clips, render: per-clip beep correlation within 1 frame; −14 ± 1 LUFS and ≤ −1 dBTP on decoded AAC; captions within S11's error; visual frames identical to the frozen edited draft (pre-encode frame hashes); **one tamper case** (edited bus, edited attribute) rejected; raw take paths 404 for a reviewer through preview and archive; a 4-min and a 10-min bus reopen and re-render; caption correction updates private and public VTT, and a correction after unpublish doesn't resurrect the mirror; a silence-only take renders. |
| **3: record a take** | Recorder (worklet → worker → IndexedDB), worker-hash upload, setup panel, muted-picture + stem monitor, calibration (S10's procedure), fit + residual stop, recovery, raw audition with decode budget, original-audio modes. | 2 | Chrome, Safari and Firefox on real hardware, with headphones: a 60 s take lands within 1 frame at start, middle and end; in *replace* mode the take has no AI-voice bleed; a reload mid-take recovers it. |
| **4: punch-in + timeline** | Multi-track timeline, punch-in with pre-roll and range muting, crossfades, split/trim/move/gain/fades, snapping, local undo, keyboard + a11y. | 3 | Three punch-ins on a 90 s video: no clicks at edit points (envelope check), sync holds at each boundary. |
| **5: fit to narration** | `author_from_frozen` run kind (manifest, reconciler, prepare-run), target duration, TTS suppression, fenced transcript, duration-only fallback, full `narration_modified` guard, cost confirm. | 2 | One fit run with narration 20% longer than the visuals: scenes total the target exactly, bus digest unchanged; a tampered variant is rejected. |
| **6: polish** | Take alternatives + takes switcher; heavy cleanup (RNNoise, declick); WebM/Opus; auto-align; MCP tools; skills page; share transcript; multilingual; iframe recording fallback if S10 needs it. | 2–4 | MCP `add_narration` + render; a Chrome WebM file uploads and renders. |

**Spike contract (phase 0).** The spikes are merged: four, not six.
- **S10, browser end-to-end harness** (sync + capture). One instrumented page.
  - Muted MP4 + `requestVideoFrameCallback` picture.
  - Stem monitor in one `AudioContext`.
  - Worklet → worker → IndexedDB capture compared with MediaRecorder: start delay, codec delay, memory.
  - The per-browser API matrix.
  - Calibration candidates (a), (b) and (c) for **headphones** and speakers, with repeatability.
  - Physical flash/beep loopback at start, middle, end and punch boundaries.
  - Built-in, USB and Bluetooth devices.
  - 10-min drift and the residual stop.
  - Stall, hidden tab and device change.
  - Stop → hash → upload → recovery timing.
  - Multi-take audition memory under the decode budget.
- **S11, STT on the runner.**
  - Parakeet, then whisper.cpp.
  - Cold 60 s, 90 s and 10 min inputs.
  - Install and download cost, RSS, CPU, and word-timestamp error against a known transcript.
  - The outer-deadline kill.
  - The whole-sequence time budget, hydrate through callback, at 90 s and 10 min.
  - The credit delta.
- **S12, render qualification** (bus + mastering + hold-frame).
  - A full-duration bus layer at 90 s and 10 min, including the reference-entry restore.
  - Automation limits and the degraded fallback.
  - Mastering by re-mux.
  - Final-AAC loudness and peak.
  - Appending a held frame under render-unchanged, and frame-prefix invariance.
- **S13, cleanup.** The light chain on 5 real recordings, compared A/B with raw and with bypass; parameter tuning.

**Credit budget (written down before starting).**
- Spikes: S11 and S12 each take about 3–5 runs, roughly 600 credits total.
- Gates: phase 2 is about 2 keep-visuals runs + 1 tamper run + 2 long-bus runs, roughly 200 credits. Phase 5 is about 1 fit run + 1 tamper run, roughly 300 credits.
- **Ceiling: 1,500 credits** for phase 0 plus all gates, including retries. Measured ranges are recorded in `docs/spikes.md` and the render dialog's copy.
- Ten-minute cost and completion time aren't advertised until they're measured.

## 10. Testing

- **Unit (vitest):**
  - `timeline.ts`: resolve, split, trim, crossfades, fit math, output limit. Property tests: no overlaps after resolve, and each source sample's composition time is preserved.
  - WAV encoder and streaming resampler, checked against a reference.
  - Peaks and speech-span summary.
  - Narration role, reader and validator in draft and materialized states.
  - `duckPoints` with spans and muted voice, plus automation ≤ 400.
  - `checkNarration` and `narration_modified` tamper cases.
  - Narration caption grouping.
  - Op schema.
  - `canReadTake` on every path, including `checkMedia`.
  - `media_refs` + GC under concurrent save, freeze and retry (PGlite with two connections).
  - Caption revision CAS and mirror generations.
  - Run-manifest serialization for `author_from_frozen`.
  - Migration snapshot.
- **Script tests:** `narration.ts` on fixtures (quiet, clipping, noisy, silence-only, quiet-into-loud punch). Assert that sample counts are preserved, check per-take loudness, check bypass is bit-exact, and check same-run determinism.
- **UI:** Playwright with a fake mic in Chromium, covering recorder state, recovery, punch range and the shortcuts. This proves wiring only; hardware sync is S10 and the phase-3 manual gates.
- **Live gates:** `scripts/e2e/narration.ts`, per §9's gate column, within the credit ceiling.

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| No headphone-compatible calibration is accurate enough. | Medium | S10 compares three procedures. The sync promise is stated only for qualified setups. The manual offset is always available. |
| The stem monitor drifts against the muted picture. | Low–Medium | One `AudioContext`, positioned from picture anchors, re-anchored on residual. S10 measures it. |
| The whole run sequence exceeds the 22-minute budget on long videos. | Medium | S11 measures the whole sequence at 10 min. STT has an outer deadline and a cache. The output limit is 15 min. |
| STT too slow or unavailable. | Medium | Parakeet, then whisper.cpp; bounded; empty-VTT fallback; caption editor. |
| Loudness misses after AAC encoding. | Medium | Re-mux mastering over the summed mix, peak-first, measured, warned. |
| The agent changes narration in fit mode. | Medium | `narration_modified` checks the effective graph against frozen inputs plus the receipt. |
| Take leaks through a forgotten path. | Medium | One predicate, a test per path, raw paths kept out of `video/`, and phase-1 and phase-2 denial gates. |
| GC deletes something still referenced. | Low | `media_refs`, row locks in id order, two-phase delete, concurrent tests. |
| Preview and render mix diverge. | Low | Shared `timeline.ts` and `duckPoints`. Audition is labelled raw. |

## 12. Owner questions (answers proposed by rounds 1–2; owner to confirm)

1. **Default render choice:** *Keep my visuals* preselected, after a duration and overflow preview and the measured cost range.
2. **Bluetooth:** warn, and prompt calibration on any new route. Don't block, and don't infer Bluetooth from labels.
3. **Unused takes:** a 30-day grace after the last reference, plus **Delete unused recordings**. Discarding a draft releases references only.
4. **Captions provider:** local by default. ElevenLabs transcription is a separate opt-in.
5. **Share-page transcript:** offered at publish with a preview, off by default for recorded narration, and the choice remembered.
6. **Limits:** 10 min / 50 MiB per take. Narration may extend the output by at most 120 s, and never past 15 min total.
7. **New: take alternatives** (a takes switcher) are deferred to phase 6. Punch-in still works, and the old take's audio is kept as source. OK?

## 13. Missing-piece checklist (each one is covered above)

- Mic denied or disconnected: §5.1, §2.1.
- Suspended or interrupted context: §2.1.
- Hidden tab: §5.3.
- Partial-upload retry and worker hash: §5.1.
- Account switch during recovery: §5.1.
- Pending timing edits: §5.3.
- Muted or empty-track captions: §6.6.
- Cancellation: §2.1, §6.4.
- Output-duration limit: §6.1.
- MCP URL ingestion: not in v1 (§7).
- Shortcuts in text fields and on non-Mac: §5.5.
- Draft expiry: §6.1.
- Autoplay gesture: §2.1.
- Revoice and narration ordering: §6.3.
- Device change mid-take: §2.1.
- Raw takes out of archives and previews: §6.2, §6.3.
- Long-bus tar limit: §6.2.
- Provenance and credits for library audio: §6.1.
- Caption cache, ETag and unpublish ordering: §6.6.

## 14. Review log

### Round 2, 2026-11-02 (Fable 5 high: 833 credits; Codex gpt-6.1-sol high: 427 credits), against `8649997`

**Taken** (claims checked against the code first):
- **Muted-MP4 picture plus a stem monitor in parent Web Audio** (both). The MP4 is one mixed AAC track (`Review.tsx:111-123`), so *replace* and punch-range muting were impossible as written. Recording is now blocked on **any** timing op, including voice ops that move beats (`contract.ts:774`) (Codex). The full sync fit plus a residual limit is stored (Codex). Calibration must work with headphones (Codex), with three candidates S10 compares (our addition).
- **Raw takes out of `video/`.** `excluded()` only skips library media (`bundle-manifest.ts:24-28`), so takes would reach archives and readable previews (Codex). The **bus is stored by reference,** because tar limits each file to 10 MiB (`tar.ts:12-16`) (Codex).
- **`narration` added to `AUDIO_ROLES`, the type, `audioOf`, the DTO enum and the editor** (both, `contract.ts:236,423-425`, `schemas.ts:753`). Fit mode uses an exact target duration (Fable). Draft and materialized states are separated, with spans from the op and take summaries so the duck lane stays valid in drafts (Codex's invalidation point, our mechanism).
- **GC:**
  - the deletion predicate is based on `media_refs`, and soft delete never overrides references (Codex);
  - row locks in id order across every reference writer, because save does its media lookup outside the edit lock (`edits.ts:160,282-301`) (both);
  - two-phase delete with a `deleting` state (both).
- **New `author_from_frozen` run kind** with manifest serialization, reconciler and prepare-run changes together (`run-manifest.ts:9,64`, `reconciler.ts:167-205`) (both; Codex on serialization). `frozen.edit` is corrected to `editId` (Codex). Pre-author order is now bus, then STT, then agent (Codex). Duration-only fallback, fenced transcript, and locks through retries (Codex).
- **Caption revisions:**
  - revision-aware signed paths (`src/domain/files.ts:44`, `edge-functions/files.ts:18,37-47`) (both);
  - caption hashes kept in `versions.captions`, separate from render receipts;
  - an ETag bump;
  - CAS;
  - mirror generations so a late correction can't undo an unpublish (Codex).
- **Mastering as a re-mux over the summed mix**, not HTML volume edits, which would violate the guard. It reuses HyperFrames' AAC peak enforcement, is peak-first, and exempts silence (Codex).
- **ffmpeg pinned** (`-threads 1 -filter_threads 1`, version recorded). Same-run hashes are the guarantee and cross-run equality is best-effort (Fable). The guard uses a **receipt** to avoid repeating cleanup, with the trust boundary stated (Codex receipts, plus Fable's CPU point).
- **One authorization predicate,** including `checkMedia` duplicate lookup (`media.ts:252-258`), search and MCP (Codex). Narration provenance and credits come through `media_refs`, because credits only count `sound`/`voiceover` today (`credits.ts:76-85`) (Codex).
- **Worker-supplied upload hash,** because `upload.ts:109` hashes the whole file in memory (Codex). The audition decode budget (Codex). An explicit output-duration limit, because none exists (`schemas.ts:332-337`) (Codex).
- **Simplifications:**
  - take alternatives deferred to phase 6 (Fable);
  - crossfade and release as constants (Fable);
  - heavy cleanup deferred (Codex);
  - no iframe fallback until needed (Codex);
  - spikes merged S10+S14 and S12+S15, with the per-clip-layer comparison dropped (both);
  - cross-version caption inheritance by PCM hash replaced with **op-hash carry-forward** (Fable's fragility point; Codex's carry-forward need).
- **Gates:**
  - a tamper case in phase 2 (Fable);
  - a bleed check in phase 3 (Fable);
  - raw-path denial, concurrent GC, long-bus reopen, caption unpublish ordering and silence-only (Codex);
  - preview parity scoped (audition labelled raw) (Codex);
  - an outer STT deadline and a whole-sequence budget, since render-job's timeout alone is 20 min (`render-job.ts:116`) (Codex);
  - a written credit ceiling (Codex).
- **Stale references refreshed** to `8649997` (both).

**Changed:**
- **Caption carry-forward:** Fable suggested dropping it; Codex required overlaying corrections. We kept carry-forward, keyed on the **op hash** rather than the PCM hash.
- **The 512-point automation cap:** Codex reported it and Fable couldn't find it. The ≤ 400 design stands either way, and S12 confirms.

**Not taken:**
- **Codex's "not ready for phase 0" verdict, as a blocker on starting.** Its three fixes are design changes now in this draft. Spike S10 can start on the §9 contract immediately.

### Round 1, 2026-11-02 (Fable 5 high: 499 credits; Codex gpt-6.1-sol high: 191 credits), against `7be32ab`

**Taken:**
- one narration bus instead of per-clip layers;
- a single-clock sync design (the iframe is opaque-origin);
- recompute-and-verify guards modelled on `checkRevoiced`;
- fit as mode `author` from the frozen edited draft, plus TTS suppression;
- narration cues as their own kind, an empty-VTT fallback, and caption revisions;
- takes outside `snapshotMedia`, hydrated by Blobs key;
- take scope enforcement, a new reference-aware GC, and a stored-bytes quota;
- Parakeet before whisper.cpp, with bounded, cached STT;
- the cleanup chain order, per-take gain, true bypass and explicit units; measuring decoded AAC; edge trim off in v1; duck release during pauses; bounded automation;
- recorder streaming to a worker and IndexedDB from chunk 1;
- integer samples and a separate peaks blob; queryable media columns; `voiceover` left as AI config; draft-expiry handling;
- a local undo stack, and reviewers not hearing drafts;
- phase reorder; caption fixes in the first release; per-clip correlation and PCM-hash gates; a gate budget;
- mic policy in the edge functions; MCP by media ids;
- factual corrections: native `loop`, the bridge's message list, no `data-va-captions` convention, `data-va-muted`, and no publish-time transcription.

**Changed:**
- Bluetooth: calibration on any new route, with no Bluetooth detection.
- Edge trim: off in v1, with Fable's sync-preserving rule kept for later.

**Not taken:**
- Fable's claim that Safari lacks `getOutputTimestamp`. Codex cited MDN. We feature-detect, and S10 decides.
- Leaving the MP4-vs-iframe recorder choice open. MP4 mode is primary.
