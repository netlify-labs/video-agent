# Record your own voice-over — plan

- **Status:** draft 2 (2026-11-02). Folds in review round 1 (Fable 5 high, Codex gpt-6.1-sol high; 690 credits). §14 lists what was taken and what was rejected. Next: phase 0 spikes. The architecture choices marked **[S10]**–**[S15]** are provisional until their spike reports numbers.
- **Owner decisions so far (2026-11-02 interview):**
  - **Recording:** a whole take first, then punch-in re-records over any range. It should feel like a video editor: recordings are clips on a Narration track that sits above Music.
  - **Re-render:** the user picks either a plain re-render (render-unchanged, visuals untouched) or "let the agent adapt", which may retime scenes to fit the narration.
  - **Captions:** recorded narration is auto-transcribed into timed captions and VTT.
  - **In scope for v1:** a mic level meter, device picker and countdown; audio cleanup; uploading an existing file instead of recording; and an option to keep the original AI voice-over or sound under the narration.
- **Builds on:**
  - [`2026-10-31-storyboard-editor-feedback-media.md`](2026-10-31-storyboard-editor-feedback-media.md): editor, drafts, render-unchanged, media.
  - [`2026-11-01-ideas-audio-skills-oauth.md`](2026-11-01-ideas-audio-skills-oauth.md): sound, music, AI voice-over.
  - SPIKES S2, S4, S5, S7 and S9.

---

## 1. Goal and why

Today a video's narration can only come from the AI: Kokoro in the run, or ElevenLabs when a key is set. People want their own voice on their own product videos. It sounds like them, it carries a demo better, and it removes the "AI voice" feel from anything that ships externally.

The feature: **press Record, watch your video play, talk over it, and get a new version with your voice mixed in, ducked music, cleaned-up audio and real captions.** If a sentence comes out wrong, re-record just that sentence. If the narration runs long, either keep the visuals (and trim or hold the last frame) or let the agent stretch the scenes to fit.

Success looks like this:
1. A creator narrates a 60–90 s video in one sitting, fixes two flubs with punch-ins, and renders. The whole thing takes under 10 minutes. The keep-visuals render is a fraction of an authoring run's cost; the exact range is an S11 output, and today's render-unchanged run is about 34 credits.
2. **Sync:** narration lands within one video frame (≤ 33 ms at 30 fps) of where the speaker heard it, on the setups S10 qualifies (wired headphones or built-in output, current Chrome, Safari and Firefox on macOS). Bluetooth and other setups are "best effort with calibration", stated in the UI.
3. **Delivered audio**, measured on the decoded final AAC: −14 ± 1 LUFS integrated, true peak ≤ −1 dBTP, speech intelligible over the ducked music.
4. **Captions** follow the words, within the timestamp error S11 measures for the chosen STT.
5. **Recordings are private** to their uploader and the videos they're used in, and unused recordings are actually deleted (§8).

Non-goals for v1:
- Multi-person or remote recording.
- Camera or picture-in-picture.
- Voice effects.
- Real-time collaborative timeline editing.
- Mobile recording (untested, unpromised).
- Browser-side MP4 rendering. S7 rejected it, and rendering stays in the Agent Runner run.

## 2. User workflows

### 2.1 Record a whole take
1. On a finished version, the user opens **Edit → Narration**, or clicks **Record voice-over** on the Video page, which opens the editor on the Narration track.
2. **Setup panel:**
   - **Mic picker** (`enumerateDevices`, remembered per browser) with a live input meter. A 3 s "check level" pass reports too quiet (< −40 dBFS RMS), OK, or clipping (≥ −1 dBFS peak).
   - **Output setup:**
     - *Headphones* (default): the video's audio plays normally while recording.
     - *Speakers*: the video's audio is muted or ducked to −30 dB while recording, and browser echo cancellation turns on.
     - The mode is fixed for the whole take, because toggling echo cancellation mid-stream can shift latency.
   - **Calibration:** a one-time flash-and-beep loopback test per audio route (input device + output device + sample rate). It's prompted on the first take with a new route and stored locally; changing the route invalidates it. A manual **Sync offset ±** slider is always available in preview. Bluetooth isn't detected or blocked. The calibration prompt and a copy line ("Bluetooth adds delay and lowers mic quality; wired is best") cover it.
   - **Original audio:**
     - *Replace AI voice-over* (default): the AI voice track is muted, but kept so it can be restored.
     - *Keep it under my voice*: the AI voice at a chosen level, −12 dB by default.
     - *Mute all original audio*.
3. The user clicks **Record**. This click is the user gesture that starts the `AudioContext` and playback (`resume()` is explicit). A 3-2-1 countdown plays while the mic is already capturing, so nothing is clipped, then the video plays from the start.
4. **Stopping:**
   - **Space** stops and keeps the take; **Esc** discards it.
   - Seeking, a playback stall, the tab going hidden, a device change (`devicechange`, mic track `ended`) or a context interruption **stops the take and keeps what was captured** up to that point, with a message saying why.
5. The take appears as a clip on the **Narration** track, with its waveform, at the video time it was recorded against.
6. **Play the mix** right away in the browser (§5.4). No render is needed.

### 2.2 Punch-in (re-record a range)
1. Select a range on the ruler, or put the playhead somewhere and press **R**.
2. **Pre-roll:** playback starts 2 s before the punch point (configurable 0–5 s), with existing narration audible so the user can match tone. At the punch-in point, armed narration in the punch range is muted, so the user doesn't hear their old take over themselves.
3. **Recording:** capture runs continuously from the countdown. Only the samples from the punch range (or from the punch point until stop) become the new clip, and the rest of the capture is kept as the take's source.
4. **Overlap:** the new clip is laid on top. Older clips are trimmed or split non-destructively, and their source audio is never modified. Each edit point gets a short crossfade using handle audio from both sides where it exists (§6.1), or edge fades where it doesn't.
5. **Takes:** every clip slot remembers its alternatives, each with its own source bounds and alignment. Right-click opens **Takes ▸ Take 3 / Take 2 / Take 1**, which swaps the take in place.

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

### 2.4 Upload instead of record
- Drag an audio file onto the Narration track, or pick one from the library.
  - Accepted formats: MP3, WAV, M4A and Ogg today; WebM/Opus once §5.2 lands.
  - It lands at the drop position (default 0) and the user aligns it by dragging.
  - From then on it behaves like a recorded take.
- **Auto-align against the AI voice track** (cross-correlation) is deferred (§9, phase 6).

### 2.5 Render
The user clicks **Render**. A dialog shows a duration and overflow preview (where narration starts and ends against the video) and the cost range for each option:

- **Keep my visuals (preselected).** This is render-unchanged.
  - Narration plays over the existing scenes. Visual frames are identical to the base version (§10 checks this).
  - **If narration runs past the end**, the user chooses:
    - trim the clip;
    - **hold the final frame** for the overrun plus a 0.5 s post-roll. This is an explicit, deterministic operation that appends a still of the last frame. It doesn't stretch the last beat's animation.
    - switch to the fit option.
- **Let the agent fit the video to my narration (≈ an authoring run, about 250 credits).**
  - An authoring run that starts from the **edited draft** (§6.4).
  - The agent gets the narration's word timings and a target duration (narration end + post-roll, frame-quantized). It may retime, extend or tighten scenes to match.
  - **The agent cannot change the narration audio.** A guard enforces this (§6.4).

**The result is a new version n+1** with:
- mode `render_unchanged` or `author` (provenance: `editedFromN`, `narration` frozen);
- narration-derived captions;
- the usual MP4, GIF, VTT and poster, plus `narration.mp3` and `transcript.txt`.

**Publication** is per version and unchanged: a published older version keeps its slug until the new one is published.

### 2.6 Fix captions afterwards
- The transcript is shown as cues, and words can be corrected. Fixes keep their timings and only change the text.
- If the version doesn't burn captions in (the default today: VTT sidecar, captions off), a fix creates a **caption revision** of that version (§6.6). This is a new immutable VTT; the output pointer and any publication mirror are updated, and **no render** is needed.
- If captions are burned in, a fix goes through the editor and a render-unchanged run.
- **Ships with the first recording release**, not later: transcription errors are common, and captions are user-visible.

## 3. Constraints from the current system

These are verified against the code, and confirmed or corrected by both round-1 reviews.

| Fact | Where | Consequence |
|---|---|---|
| Every MP4 renders in an Agent Runner run (`render-job.ts:114`). There's no function-side or browser render path (S7). Render-unchanged has cost 33.6–34.4 credits. | `prompt.ts:303-354`, `docs/spikes.md:164-175,197-217` | Keep-visuals is a render-unchanged run. New narration processing adds time and cost, which S11 measures. |
| Versions have two **modes**, `author` and `render_unchanged`; "revise" is a run kind, not a mode. An author run with a parent restores the **parent's** archive, not the edited draft. | `types.ts:260`, `run-manifest.ts:9`, `reconciler.ts:195-198` | Fit-to-narration needs the author run to start from the frozen edited draft (§6.4). |
| `validate()`: every `data-va-layer` root child must be on track ≥ 1 and **span the whole video**. Any other timed root child that isn't a beat is a violation. | `contract.ts:336-347` | Per-clip narration elements are illegal. |
| `relayout()` (on every `applyEdits` and `applyRevoice`) rewrites **every** `data-va-layer` to start 0 and full duration, then calls `applyDucking`. | `contract.ts:569-573` | Per-clip timing would be wiped on the first save. One full-duration narration bus is the only shape that survives (§6.2). |
| AI voice is at most one `<audio data-va-voice="<beat>">` per beat, ending inside the beat. | `contract.ts:372-401` | AI voice stays as it is, and narration is separate. |
| Ducking: `duckPoints` derives dips **only from beat voices**, and `validate()` fails a `data-va-duck` lane that doesn't match it. `data-va-duck` marks the *recipient* (music). | `contract.ts:403-410,468-526` | `duckPoints` itself must learn narration speech spans, in shared code (§6.3). |
| Mute is `data-volume="0"` **plus** `data-va-muted`, with the level kept in `data-va-volume`. HyperFrames mixes every timed `<audio>` whatever its `muted` attribute says. | `contract.ts:696-718` | AI-voice "replace" reuses exactly this. |
| HyperFrames 0.8.222 audio: `data-start`, `data-duration`, `data-volume`, `data-media-start` (source offset), `data-playback-start` (**overrides** `data-media-start`) and `data-automation`. Automation is clip-local, multiplies gain, and is capped at **512 points**; the mixer has a fallback that degrades automation. Looping uses native `loop`, not `data-loop`. Every `<audio>` needs an `id`. | `node_modules/hyperframes/dist` (Codex round 1), `video/AGENTS.md:142` | Fades and ducking go through bounded automation, and degraded-render warnings must fail the run (§6.3). |
| Captions: `validate()` requires each cue to have `beat`+`textId`, or `voice: true` tied to a **voiced** beat. `syncVoice` rewrites voice captions and drops captions in voiced beats. | `contract.ts:433-452`, `scripts/voice.ts:145-173` | Narration cues need their own cue kind (§6.6). |
| `captions.vtt` is a **required** output file. | `types.ts:775`, `finalize.ts:64,141` | A failed transcription produces an empty valid VTT plus a status; captions never go missing (§6.6). |
| Audio is sniffed by content: MP3, PCM WAV, Ogg Vorbis/Opus, M4A/AAC. **WebM is rejected.** Limits are 50 MiB / 600 s. | `classify.ts:21-37,121-162`, `audio.ts:208` | Recordings upload as 24 kHz PCM16 WAV (28.8 MB for 10 min). WebM is upload-path only (§5.2). |
| Upload sessions: 4 MiB parts, 100 MiB session ceiling, whole-file hash before upload. Completion can return **before** the media is ready. The 1 GiB quota counts **unfinished uploads only**. | `upload.ts:93-158`, `media-uploads.ts:14-57`, `store/drizzle.ts:463` | Takes need a stored-bytes budget of their own (§8), and recovery waits for "ready" (§5.1). |
| Version media snapshots are capped at **12 items / 300 MiB**, inherit previous items, and hydrate to `video/assets/media/` by **Blobs key + sha256** (not signed URLs). | `media.ts:260-296`, `prepare-run.ts:30-34,182-197` | Takes get their own snapshot list, cap and directory (§6.1). |
| `loadMedia` lets **any signed-in reader** load any *ready* media item and get a signed link. "Private" means signed-in only. | `media.ts:231-233,145` | Takes need scope enforcement (§8). |
| No media GC exists. Delete is soft. The sweep reaps uploads, drafts, idempotency rows, plans, OAuth and sessions, but never media bytes. | `media.ts:253-258`, `cleanup.ts:1-35` | Deleting recordings is new work (§8). |
| Drafts are **author-only** and expire after 7 days. Their bundles are deleted, and only the newest revision is kept. | `edits.ts:29,208,265,329-335` | Reviewers hear committed versions only. Draft expiry has to be handled for takes (§6.1). |
| Preview iframe: `sandbox="allow-scripts"` (opaque origin, its own time origin). The bridge sends `ready`, `time` (only when moved > 20 ms), `click`, `error` and `edits-applied`. It doesn't send play, pause or ended. | `CompositionPreview.tsx:236`, `preview.ts:59`, `bridge.js:12-64` | Its clock can't be compared with the parent's directly (§5.3). |
| The Video page plays the **MP4** in a native `<video>` (`Review.tsx:89-126`). | `Review.tsx` | A same-document clock with `requestVideoFrameCallback` is available (§5.3). |
| Loudness is normalized only by the agent, on music, through the prompt. Voice WAVs aren't normalized. `hyperframes audio` analyses individual sources, not the summed mix. | `prompt.ts:215,262`, HyperFrames `audio-*.js` | Our script masters the mix and measures the decoded final AAC with ffmpeg `ebur128` (§6.3). |
| No STT on the AI Gateway. `hyperframes transcribe` fails on the runner with `whisper_unavailable`, and the error **suggests `hyperframes models install parakeet`**. `transcript.json` is already a recognized project file. | `docs/spikes.md:229-249`, `video/AGENTS.md:84` | S11 tries Parakeet first, then whisper.cpp (§6.6). |
| No `Permissions-Policy` anywhere. `netlify.toml` headers cover static responses only; share and embed pages are edge-function responses. | `netlify.toml:34`, `netlify/edge-functions/*` | Set the mic policy in both places (§8). |

## 4. Architecture overview

```
Browser (editor)                                   Functions / DB / Blobs                     Agent Runner run
────────────────                                   ──────────────────────                     ────────────────
Recorder: AudioWorklet → worker (resample 24k,      upload session → media{kind:audio,
  PCM16 WAV, peaks) → IndexedDB from chunk 1 ─────▶   role:narration-take, scope}
Sync: MP4 <video> + requestVideoFrameCallback        take scope enforced on read/link/reuse
  + AudioContext in ONE document [S10]
Timeline (src/lib/timeline.ts, integer samples)      saveEdit: narration op (whole-track
  local undo stack ─────────────────────────────────▶   snapshot) → buildRev
Live mix preview: composition iframe for visuals,
  parent Web Audio for narration (±1 frame) ─────── Render ─▶ renderEdit: freeze draft +
                                                     take snapshots + pipeline settings ──────▶ prepare-run: hydrate takes
                                                                                                  by Blobs key + sha256
                                                                                                scripts/narration.ts:
                                                                                                  clean per take → mix bus
                                                                                                  → master → measure
                                                                                                transcribe (Parakeet/whisper,
                                                                                                  bounded, optional)
                                                                                                checkNarration() guard
                                                                                                hyperframes check/render
                                                                                                finalize (+narration.mp3)
```

What goes where, and why:
- **Recording happens in the browser.** Only the browser has the mic. PCM through an AudioWorklet gives per-sample positions, while MediaRecorder has codec delay, opaque timing and WebM output. S10 compares the two and keeps the winner.
- **One clock for recording [S10].** We record against the **base version's MP4** in the parent document, so the video, the mic and the `AudioContext` share one `performance.now()` timeline. `requestVideoFrameCallback` gives exact presented-frame media times. The composition iframe stays for the post-record mix preview, where ±1 frame is acceptable.
- **The timeline is a whole-track snapshot op** on the existing draft system. That gives optimistic saves (`expectedRev`), CSRF, roles and the frozen render inputs. Undo is a local command stack.
- **One narration bus in the composition.** The run mixes clips into a single full-duration WAV, which is the shape `validate()` and `relayout()` already accept for layers. Clip-level data lives in the op and in `versions.narration`.
- **All audio processing is deterministic code in the run** (`scripts/narration.ts`); the agent only invokes it. The same code runs in both render modes, so they sound the same. Source takes are never modified.

## 5. Browser: recording, sync and preview

### 5.1 Recorder
- **Mic stream:** `getUserMedia({ audio: { deviceId, channelCount: 1, echoCancellation: <speakers mode>, noiseSuppression: false, autoGainControl: false } })`.
  - Browser noise suppression and auto-gain are off because they pump the level and smear consonants; cleanup happens in the run.
  - Stop the mic tracks when leaving the editor or cancelling.
- **Capture chain:** `AudioContext` → `MediaStreamAudioSourceNode` → `AudioWorkletNode('va-recorder')`.
  - The worklet's output is silent: it isn't connected to the destination, or it goes through a 0-gain node, so the user never hears themselves delayed.
  - The worklet posts **transferable** Float32 blocks with their context sample index to a **Worker**.
- **Worker** (bounded memory):
  - incrementally resamples to 24 kHz (polyphase, streaming) and encodes PCM16;
  - computes multiresolution peaks;
  - hashes incrementally;
  - writes every chunk to **IndexedDB from the first chunk**, keyed by recording UUID with a sample sequence.
  - Only the analyser and the last few seconds stay in memory. A 10-min take at 48 kHz Float32 would be 115 MB, so it's never held whole.
- **Recovery record:** the recording UUID, sample sequence, clock anchors (§5.3), device route, the draft id and `expectedRev`, and upload state.
  - On reload, the editor offers to recover takes that are unsaved or not yet uploaded.
  - The local copy is kept until the media is **ready** and the draft save that references it has succeeded.
  - Quota errors stop the take cleanly, keep what was saved, and say so.
  - Sign-out or account switch: recovery records belong to the user id and are never offered to another user.
- **On stop:** finalize the WAV in the worker and upload through the existing sessions with `role: 'narration-take'`. The editor waits for media `ready` before treating the take as durable.
- **Level meter:** an `AnalyserNode` showing RMS and peak, with a clip indicator latched for 1 s.
- **Mic denied or missing:** a clear empty state with retry, and links to the browser's permission settings. Upload instead of record stays available.

### 5.2 Upload instead of record
- Reuse `ui/src/lib/upload.ts` sessions with `role: 'narration-upload'`.
- **WebM/Opus in the classifier:**
  - Parse EBML **structurally**. Accept one audio track only (`A_OPUS`/`A_VORBIS`) and reject files with video tracks.
  - Bound duration, channels and decode work. Substring checks for codec names aren't enough.
  - ffprobe re-checks in prepare-run, as other audio is today.
  - Add a fixture to `media.test.ts`.

### 5.3 Sync clock [S10]
The goal: for source sample *k* of a take, find the composition time *t* the speaker was seeing and hearing.

**Primary design: record against the base MP4 in the parent document.**
- **The player:** while armed, the editor shows the base version's MP4 in a parent-document `<video>`. The composition iframe isn't used for recording.
  - The visuals are identical to what keep-visuals renders.
  - For fit-to-narration, the agent fits visuals to the narration afterwards anyway.
  - Visual edits in the same draft (retime, reorder, delete) disable recording, with "render or discard visual edits first". Recording against a moving target is out of scope.
- **Visual anchor:** `requestVideoFrameCallback` gives `(mediaTime, expectedDisplayTime)` for every presented frame, on the parent's `performance.now()` clock.
- **Audio-output anchor:** where `AudioContext.getOutputTimestamp()` is available (feature-detected; MDN lists Safari 14.1+ and Firefox 70+), it maps context time to performance time at the output.
  - **Don't add `outputLatency` on top**, because that double-counts.
  - The MP4's own audio reaches the speakers through the media element's pipeline. Its output delay versus the visuals is measured by calibration, not assumed.
- **Input anchor:** worklet blocks carry context sample indices. Mic input latency isn't reported reliably (`getSettings().latency` is a target, and `baseLatency` is output processing), so it comes from **calibration** (below), stored per route.
- **Fit:** from anchors collected across the take, fit `t = a + b·sample`.
  - If the slope deviates from 1/sampleRate beyond a threshold, or there's a discontinuity (stall, seek, dropped frames), the **take stops at the discontinuity** and keeps the clean part.
  - We don't "correct" continuous drift silently.
  - Raw samples are always kept, and alignment is stored separately as `{anchorFit, calibrationOffsetMs, manualOffsetMs}` so it can be redone.
- **Calibration (per route):** a flash-and-beep loopback at the start, middle and end of a 10 s test clip, measuring the total offset between what's on screen and heard and what comes back through the mic. The UI explains that it's the speaker's real-world delay.
- **Fallback for the composition iframe** (if MP4 mode fails S10 on some browser): the parent stamps bridge `time` messages on arrival with `MessageEvent.timeStamp`, which is on the parent clock. The iframe clock is never used directly. The bridge posts every frame while a `recording` flag is set, and adds `playing`, `paused`, `ended`, `seeked` and `stalled` events with a sequence number and epoch.
- **Tab must stay visible** while recording, because rAF and `requestVideoFrameCallback` throttle in hidden tabs. Hiding the tab stops the take (§2.1).

**S10** measures the anchor accuracy per browser, the API matrix, calibration repeatability, local drift over 10 minutes, and MP4 mode against iframe-message mode. It also compares MediaRecorder start and codec delay against worklet PCM.

### 5.4 Live mix preview
- **Visuals:** the composition preview iframe, which reflects the draft's audio ops.
- **Narration:** the parent mixes clips with Web Audio `AudioBufferSourceNode`s, scheduled against the bridge clock, with the same crossfades as `src/lib/timeline.ts`.
- **Mix control:** a new bridge command, `mix{tracks}`, sets track volumes and mutes on the iframe's `<audio>` elements. Music ducking in preview **imports** the shared `duckPoints` (§6.3); nothing reimplements it.
- **Accuracy:** ±1 frame is fine for preview. The phase-2 gate compares an offline render of the preview mix with the MP4 audio (§10).
- **Waveforms:** decoded and drawn from the stored multiresolution peaks, never from full decodes of long takes. Decode work is capped by zoom level.

### 5.5 Timeline UI
- `ui/src/components/timeline/`: `Timeline.tsx`, `Track.tsx`, `Clip.tsx`, `Ruler.tsx`, `Playhead.tsx`.
- **Rendering:** start with accessible DOM lanes, since there are only four. Move to canvas only if profiling shows a need.
- **Model:** `src/lib/timeline.ts` is pure TypeScript shared by the UI and the server. It resolves overlaps, converts integer samples to seconds, quantizes visuals only, and does gain and fade math. Undo is a reducer over commands.
- **Keyboard shortcuts:**
  - Space: play/pause
  - R: record or punch
  - S: split
  - Del / Backspace: delete
  - ⌘Z / Ctrl+Z: undo; ⇧⌘Z / Ctrl+Y: redo
  - ←/→: nudge one frame; ⇧ nudges 10 frames
  - All shortcuts ignore input fields.
- **Accessibility:**
  - Every action is also in a clip menu.
  - Clips are focusable and move with the arrow keys.
  - The recorder announces its state through `aria-live`.

## 6. Server and run: data, contract, render

### 6.1 Data model
- **Takes are media rows** with `kind: 'audio'`. They also get **queryable** columns:
  - `role: 'narration-take' | 'narration-upload' | null`
  - `scope_job_id`, the video it was recorded for
  - `retain_until`
  - an index on `(uploader_id, role)`

  These are needed for filtering, scope checks and GC; `meta.json` isn't enough for any of them. `meta.json` keeps sampleRate, duration (in samples), the sync record and a hashed device label. Peaks are stored as a **separate Blob**, `<id>/peaks.bin`, holding multiresolution min/max pyramids as Int8 (about 60 KB for 10 min), and are served with the media.
- **Edit op: one whole-track snapshot.** This matches the full-op-list save model (`edits.ts:279-304`). Version 1 of the schema:
  ```ts
  type NarrationOp = {
    op: 'narration'
    schema: 1
    sampleRate: 24000                       // all source coordinates are integer samples at this rate
    clips: Array<{
      id: string                            // stable slot id
      take: {                               // the selected alternative
        mediaId: string
        srcStart: number                    // integer samples into the source
        srcEnd: number                      // integer samples, > srcStart
        alignOffsetSamples: number          // per-take alignment (sync fit + calibration + manual)
      }
      alternatives: Array<{ mediaId: string; srcStart: number; srcEnd: number; alignOffsetSamples: number }>
      start: number                         // composition position, integer samples
      gainDb: number                        // finite, -60..+12; -Infinity encoded as null = silent
      fadeInSamples: number                 // 0..min(len/2, 2 s)
      fadeOutSamples: number
      xfadeHandleSamples?: number           // crossfade handle at edit points (default 480 = 20 ms)
    }>
    tracks: {
      narration: { volumeDb: number; muted: boolean; solo: boolean }
      aiVoice:   { mode: 'replace' | 'under' | 'keep'; volumeDb: number }
      music:     { duck: boolean; duckDb: number; releaseAfterPauseMs: number }
      original:  { muteAll: boolean }
    }
    cleanup: { preset: 'off' | 'light' | 'heavy'; declick: boolean }
    trimSilentEdges: false                  // reserved; off in v1 (§6.3)
  }
  ```
- **Validation** (zod in `src/schemas.ts`, plus server-side `timeline.resolve()`):
  - Clips are resolved and must not overlap after resolution.
  - Every number is finite, and source bounds fit inside the take's duration.
  - At most 200 clips and 32 distinct takes per op.
  - Every referenced `mediaId` must be in scope (§8). **New** picks are authorized against the current user. **Inherited** references (from the base version's frozen narration) are allowed even if the take was since soft-deleted or ownership changed, because the version already owns those bytes.
- **Version fields:**
  - `versions.voiceover` stays as the AI synthesis configuration and doesn't change.
  - New `versions.narration jsonb`, nullable, holds the resolved op plus the pipeline version and settings.
  - The "AI / recorded / mixed" badge is **derived** from the audible tracks, not stored.
  - Migration: one nullable jsonb column plus the media columns above, generated with `npm run db:generate` (new migration only).
- **Snapshots:** takes are **not** snapshotted through `snapshotMedia`, which has a 12-item / 300 MiB cap and puts files under `assets/media/`. `renderEdit` writes `frozen.narration.takes: [{mediaId, key, sha256, bytes}]`, capped at 32 takes / 400 MiB, and prepare-run hydrates them by Blobs key + sha256 into `video/assets/narration/src/`. References inherited by version n+1 that aren't audible are pruned at freeze.
- **Draft expiry:** drafts expire after 7 days (`edits.ts:29`). The narration op dies with the draft; the takes don't. Reopening the editor on that version lists **"Recordings for this video"** (scope_job_id), with re-attach. GC respects `retain_until` (§8).

### 6.2 Contract (composition HTML)
- The run **pre-mixes** all clips into one full-duration WAV, `assets/narration/bus.wav`. It's padded with silence and is exactly the root duration in samples. The composition carries exactly one narration layer:
  ```html
  <audio id="va-narration" data-va-layer="narration" data-va-audio="narration"
         data-track-index="4" data-start="0" data-duration="<root>"
         data-volume="1" src="assets/narration/bus.wav"></audio>
  ```
- This is already legal under `validate()`: a layer on track ≥ 1 that spans the video. `relayout()` keeps it correct when the root duration changes. The bus is re-mixed whenever the duration changes, because the run regenerates it from the op.
- **Reader:** `read()` classifies `data-va-audio="narration"` explicitly, not as SFX. A narration validator checks:
  - one element at most;
  - `src` is `assets/narration/bus.wav`;
  - the file's duration equals the root duration.
- **AI voice modes** reuse the existing mute semantics (`data-volume="0"` + `data-va-muted`, level kept in `data-va-volume`):
  - *replace* mutes every `data-va-voice`;
  - *under* sets the chosen level;
  - *keep* leaves them unchanged.
  - Captions follow what's audible (§6.6).
- **No per-clip attributes** go into HTML. Takes, bounds, gains, fades and crossfades exist only in the op and `versions.narration`. The editor renders the track from there.
- **`data-va-speech`:** the server writes the narration's merged audible speech spans (from the bus mix plus a VAD threshold; seconds, frame-quantized, bounded count) onto the narration element. `duckPoints` reads them (§6.3).

### 6.3 Processing, ducking and the keep-visuals render
**`scripts/narration.ts`** is deterministic, versioned with `NARRATION_PIPELINE = 1`, and invoked by the run, never edited by it:

1. **Hydrate and verify.** Hydrate the takes from `frozen.narration.takes` and verify sha256. ffprobe each: 24 kHz mono PCM16 expected for recordings; uploads are decoded to that.
2. **Clean each take.** Cleanup runs per source take, so a quiet take punched into a loud one is levelled per take. The chain preserves sample count, so there's no time-stretch and no trim:
   1. `highpass=f=80`.
   2. If `declick`: `adeclick`. It runs **before** denoising, because clicks poison the noise estimate.
   3. Denoise: `light` = `afftdn` with conservative noise reduction; `heavy` = `arnndn` with a pinned RNNoise model (license and sha recorded; any algorithmic delay compensated so the output is sample-aligned). The `off` preset is a **true bypass** of this whole step.
   4. A gentle de-esser.
   5. A compressor with explicit units: 2:1, threshold −24 dBFS, attack 10 ms, release 120 ms, soft knee.
   6. **Per-take gain** toward a speech target, from gated integrated loudness of the take's speech regions. Silence-only takes are handled explicitly: no gain is applied, and a warning is shown.

   S13 tunes these defaults on real recordings. `light` is the default.
3. **Mix the bus.** Mix the clips into `bus.wav` at their sample positions with gains, fades and handle crossfades, using `src/lib/timeline.ts` math (the same module the browser uses).
4. **Duck.** `duckPoints` (`contract.ts:468-491`) is extended in shared code. Its sources are:
   - beat voices, as today, but **excluding muted AI voice**;
   - `data-va-speech` spans from narration.

   Spans are merged, with a `releaseAfterPauseMs` rule (default 1500 ms) so continuous narration doesn't hold the music down for the whole video. Automation points are **simplified to ≤ 400**, under the 512 cap with headroom. `validate()` keeps checking the lane, now against the extended `duckPoints`.
5. **Master and measure.** After `hyperframes render`, decode the final MP4's AAC and measure with `ffmpeg ebur128`: integrated −14 ± 1 LUFS, true peak ≤ −1 dBTP.
   - If the loudness is out of range, apply **one** linear gain correction to the narration and music track volumes (the HTML `data-volume` values), re-render the audio only if HyperFrames allows it, or else fail with the measured values.
   - The bus is pre-limited at −2 dBTP to leave AAC encoding headroom.
   - **Any HyperFrames warning that automation was degraded fails the run.**
6. **Transcribe.** See §6.6. Bounded, optional, and never blocks the render.

**Edge trimming is off in v1.** Silence at clip edges stays. If added later, it must preserve `t = start + (sourceSample − srcStart)/sampleRate` by moving `srcStart` and `start` together, and it's computed in the browser at save time, so the run stays timing-neutral.

**Keep-visuals guard (`checkNarration`, modelled on `checkRevoiced` in `src/lib/revoice.ts:71-135`):**
- `renderEdit` freezes:
  - the edited draft bundle (as today);
  - `frozen.narration` (op, takes, pipeline version and settings);
  - the caption policy;
  - the target duration (the base duration, plus the hold-frame overrun if chosen).
- render-job:
  1. Recompute the expected HTML transformation: the narration element, `data-va-speech`, the duck lane and AI-voice mute attributes, from the frozen inputs only.
  2. Check that `index.html` equals frozen + exactly that transformation.
  3. Check that `bus.wav` equals the deterministic remix, by recomputing its PCM hash in the run from the same frozen inputs.
  4. Check that `summary.json` equals frozen + the narration cues, and nothing else.
  5. Check that every other file is byte-identical to the frozen bundle.
- **Revoice and narration in one draft:** revoice runs first (`voice.ts revoice` + `checkRevoiced`), then narration, and `checkNarration` composes with it. One ordering function in `src/lib/narration-run.ts` is used by the prompt and by the guard.
- **Hold-final-frame** is a deterministic contract operation: append a final beat that holds the last frame for the overrun + post-roll, flagged `data-va-hold`. The guard accepts exactly that.

### 6.4 Fit-to-narration render
- **Mode and starting point:**
  - Mode `author`, with provenance `editedFromN` and `narration` frozen.
  - It needs a reconciler change: when `frozen.edit` is present, an author run restores the **frozen edited draft** instead of the parent's archive (`reconciler.ts:195-198`).
  - Requires the narration op; the API and MCP refuse fit mode otherwise.
- **Order:** `scripts/narration.ts` steps 1–4 run **before** the agent, so the agent sees the final bus, the speech spans and the transcript.
- **Prompt:** narration is locked.
  - The `voiceLines` TTS instructions (`prompt.ts:271-297`) are **suppressed** when narration is present in replace mode. In keep or under mode, AI voice is kept as it is.
  - The agent gets the transcript with word timings and the frozen **target duration** (narration end + post-roll, frame-quantized). It fits beats to that duration.
- **Guard (`narration_modified`):** expected values derive from the frozen inputs, never from anything the agent wrote. render-job verifies:
  - exactly one narration element, with its full serialized attribute set as expected;
  - the `bus.wav` PCM hash;
  - no added or removed `<audio>` with narration roles;
  - no new `<audio>` whose time range overlaps narration speech, unless it was in the frozen bundle;
  - no audio effect, automation or volume control on the narration element or any group or master bus that touches it. The **effective render audio graph** is checked, not just the element.
- **Later revisions** of a version with locked narration keep the lock unless the user edits narration in the editor.
- Cost: an authoring run, about 250 credits. The confirm dialog shows it before starting.

### 6.5 Why processing is deterministic code, not prompt
- Loudness today is a prompt instruction, and only music gets normalized.
- Narration quality is the whole point of this feature, so cleanup, mixing, ducking and mastering are one versioned script with fixed parameters, unit tests on fixtures and measured output. The agent only runs it.
- The same script runs in both render modes, so "fast" and "agent" outputs sound the same.

### 6.6 Captions from transcription [S11]
- **Provider order:**
  - **Local first:** Parakeet through `hyperframes models install parakeet` + `hyperframes transcribe`, if S11 shows it installs and runs inside the time budget on the runner. **whisper.cpp** is the fallback, with a pinned binary, model digest and license, and a parsed JSON output schema with explicit word or token timings.
  - ElevenLabs Scribe is **opt-in only**, a separate setting from the TTS key, because sending someone's voice to a third party needs its own consent.
  - `transcriptionProvider: 'local' | 'elevenlabs' | 'off'`, default `local`.
- **Budget:**
  - Decode a 16 kHz STT input from `bus.wav`.
  - Transcription gets its own timeout (S11 sets it; it must leave render, upload and callback time inside the existing 22-min authoring / 25-min runner limits) and is killed on timeout.
  - Results are cached by `(bus hash, provider, model, language)` in Blobs, so re-renders with unchanged narration don't re-transcribe.
- **Cues:** a new cue kind `narration: true`, with absolute `start`/`end`, `text`, a stable `id`, `busHash` and `words[]`. It has no beat or textId, so `validate()` exempts it. Words are grouped into phrases by explicit rules: 42 characters max per line, 2 lines, split at pauses > 300 ms and at punctuation, 1–6 s per cue. That logic lives in `src/lib/narration-captions.ts`; `voiceCaptions` isn't reused, since it formats beat-bound cues.
- **What's captioned is what's audible:**
  - *replace*: narration cues only.
  - *under* / *keep*: narration cues plus AI voice cues, interleaved by time, with AI cues marked.
  - Muted narration: no narration cues.
- **Failure:** the render still succeeds. `captions.vtt` is written as a **valid empty VTT**, since it's a required output, and the version records `captions.status: 'failed' | 'off' | 'ok'`. The UI shows "No captions: retry or add them".
- **Caption revisions (fixes without a render):**
  - `POST /api/v1/videos/:id/versions/:n/captions` takes `{expectedRev, cues}`.
  - It writes an immutable `captions.r<k>.vtt`, updates the version's output pointer and sha256, and rewrites the publication mirror if published.
  - It needs owner or admin, plus publish authority when the version is published.
  - Text is escaped. It's rejected for burned-in captions, which need the render path.
  - Later versions made from this one inherit the corrected cues as long as the narration bus hash is unchanged.
- **Language:** English in v1. A per-video `language` setting and a multilingual model are deferred (phase 6).

### 6.7 Outputs
- **Files:** the usual mp4, gif, poster and vtt, plus `narration.mp3` (192 kbps CBR, the processed bus) and `transcript.txt`.
- **Publication:** both new files follow the version's publication.
- **Share page transcript:** offered in the **publish dialog** with a preview. It's off by default for recorded narration, and the choice is remembered per user (§12.5).

## 7. API and MCP

- **REST changes**, documented in OpenAPI and checked by `openapi:check`:
  - Upload sessions accept `role` and `scopeJobId`.
  - `GET /api/v1/videos/:id/recordings` lists in-scope takes for that video.
  - `GET /api/v1/videos/:id/versions/:n/narration` returns the resolved op and the transcript.
  - `POST …/versions/:n/captions` creates a caption revision (§6.6).
  - Draft endpoints accept the `narration` op.
  - `renderEdit` gains `mode: 'keep_visuals' | 'fit_to_narration'` and `holdFinalFrame?: boolean`. The idempotency key includes the rev, the mode and the settings.
- **MCP** (phase 6): `get_narration`, `add_narration {mediaId, start}` (media ids only, no URL ingestion in v1, to avoid SSRF and size handling) and `render_with_narration {mode}`. Fit mode is refused without narration. Recording itself is browser-only.
- **Skills zip:** a `narration.md` page.

## 8. Security, privacy, roles

- **Roles:**
  - Record, upload and render need Creator (`edit:create`, `media:upload`).
  - Drafts stay author-only (`edits.ts:265`). Reviewers hear **committed versions**, never draft takes.
- **Take scope (new enforcement):** a narration take or upload is readable only by:
  - its uploader;
  - anyone who can read a version whose frozen narration references it, and only through that version's outputs (the bus and MP4), not the raw take;
  - admins.

  `loadMedia`, signed-link issuance, library listings, reuse in ops and upload finalization all enforce this, across REST and MCP. This closes today's rule that any signed-in reader can load any ready media.
- **Runner trust model:** Creators' runs can read project storage (plan 2026-10-31, "Roles and privacy (R)", rule 5: the v1 trust model is an owner decision). Take privacy is enforced at the app layer; we don't promise isolation from runs in this deployment. The setup docs say so.
- **Retention and GC (new):** a reference-aware sweep step hard-deletes take bytes (`original`, `peaks.bin`, cached transcripts) when a take is soft-deleted, or unreferenced and past `retain_until`.
  - **Unreferenced** means not in any open draft, not an alternative in a draft, not in any frozen attempt, and not in any version's `frozen.narration`.
  - Default `retain_until` = 30 days after last reference. **Delete unused recordings** in the UI deletes immediately.
  - It's race-safe: the sweep re-checks references in the same transaction that tombstones the row.
  - Browser recovery copies are cleared on ready + save, on explicit discard, and after 7 days.
- **Budgets:** a stored-bytes quota for takes (default 2 GiB per user, configurable) and a rate limit on take uploads. The existing 1 GiB quota covers unfinished uploads only.
- **Mic policy:** `Permissions-Policy: microphone=(self)` on app routes (static, via `netlify.toml`). `microphone=()` is set **in the edge functions** for share, embed and public pages. Both are tested live with a header check in `scripts/e2e`. The preview iframe never gets mic access.
- **Disclosure:** settings and docs state that recordings are stored on this deployment's Netlify Blobs, that runs can read them (above), and that ElevenLabs transcription, if enabled, sends audio to ElevenLabs.

## 9. Phases and dependencies

The order was changed after review: storage, privacy and the upload-to-render path first, to prove the render pipeline without browser sync risk, then recording, then punch-in, then fit.

| Phase | Contents | Depends on | Live gate |
|---|---|---|---|
| **0: spikes** | **S10 sync:** MP4 + `requestVideoFrameCallback` mode against iframe-message mode; per-browser API matrix (Chrome, Safari, Firefox); worklet PCM against MediaRecorder (start and codec delay, memory); physical flash/beep loopback at start, middle, end and at punch boundaries; built-in, USB and Bluetooth; 10-min drift; stalls, hidden tab and device change. **S11 STT:** Parakeet, then whisper.cpp, on the runner, with cold 60 s / 90 s / 10 min inputs; install and download cost, RSS, CPU time, word-timestamp error against a known transcript, timeout behaviour, credit delta. **S12 render:** one full-duration bus against 50 and 200 per-clip elements; automation-point limits and the degraded-mix fallback; final-AAC loudness after encoding. **S13 cleanup:** the chain on 5 real recordings, A/B against raw; RNNoise model license and delay. **S14 capture:** worker + IndexedDB over 10 min; memory, quota, recovery. **S15 hold-frame:** append-a-held-frame under render-unchanged, and frame-prefix invariance. | — | `docs/spikes.md` S10–S15 with numbers; architecture choices confirmed or revised in draft 3. |
| **1: storage + privacy** | Media columns + migration, take scope enforcement on all read paths, peaks blob, stored-bytes quota, reference-aware GC, mic Permissions-Policy (static + edge), recordings list endpoint. | 0 | A non-uploader gets 404 on a take through REST and MCP; GC deletes an unreferenced take's bytes and keeps a referenced one. |
| **2: upload → render (keep visuals)** | `narration` op (single and multi-clip, no recording UI), `src/lib/timeline.ts`, `scripts/narration.ts`, extended `duckPoints`, narration layer + reader/validator, `checkNarration`, transcription (local, bounded, cached), narration cues, empty-VTT fallback, caption revisions endpoint + editor, `narration.mp3` / transcript outputs, hold-final-frame. | 1 | Upload a fixture WAV with known beeps and transcript, place 3 clips, render: beeps land within 1 frame locally at each clip (per-clip correlation, not one global one); −14 ± 1 LUFS and ≤ −1 dBTP on decoded AAC; captions within S11's error; visual frames identical to base. |
| **3: record a take** | Recorder (worklet → worker → IndexedDB), setup panel (meter, device, output mode, calibration, countdown), MP4-mode sync, take upload + ready wait + recovery, live mix preview (parent Web Audio + `mix` command), original-audio modes. | 2 | Chrome, Safari and Firefox on real hardware: a 60 s take with the calibration clip lands within 1 frame at start, middle and end; a reload mid-take recovers it. |
| **4: punch-in + timeline** | Multi-track timeline, punch-in with pre-roll and armed muting, alternatives with per-take alignment, handle crossfades, split/trim/move/gain/fades, snapping, local undo, keyboard + a11y. | 3 | Three punch-ins on a 90 s video: no clicks at edit points (peak/RMS envelope check), sync holds at each boundary, switching takes keeps alignment. |
| **5: fit to narration** | Author run from the frozen edited draft, TTS suppression, target duration, full `narration_modified` guard, cost confirm. | 2 | One fit run with narration 20% longer than the visuals: scenes extend, bus PCM hash unchanged, guard rejects a deliberately tampered variant (unit + one live run). |
| **6: polish** | WebM/Opus classifier, auto-align for uploads, MCP tools, skills page, share-page transcript, multilingual STT. | 2–4 | MCP `add_narration` + render through the API; a Chrome WebM file uploads and renders. |

## 10. Testing

- **Unit (vitest):**
  - `timeline.ts`: overlap resolution, split, trim, alternatives, crossfade handles. Property tests: no overlaps after resolve; a source sample's composition time is preserved through every operation.
  - Sync fit math: synthetic slope, discontinuities, calibration offsets.
  - WAV encoder and streaming resampler, checked against a reference.
  - Peaks pyramid.
  - Narration layer reader and validator.
  - `duckPoints` with narration spans and muted AI voice, plus automation simplification ≤ 400 points.
  - `checkNarration` and `narration_modified` (tampering cases: attribute, effect, extra audio, replaced bus).
  - Narration captions grouping.
  - Op schema.
  - Take scope on every read path.
  - GC reference rules and races.
  - Migration snapshot.
- **Script tests:** `scripts/narration.ts` on fixtures in `test/fixtures/narration/`: quiet, clipping, noisy room, silence-only, punch-in of a quiet take into a loud one. Assert that sample counts are preserved, measure per-take loudness, check bypass is bit-exact, and check bus determinism (same inputs give the same PCM hash).
- **UI:** Playwright on the mock build with a fake mic (`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture`) in Chromium. Covers recorder state, recovery, punch-range selection and the shortcuts.
  - This proves wiring, **not** hardware sync. Hardware sync is S10 and phase-3 manual gates on real Chrome, Safari and Firefox.
- **Live gates:** `scripts/e2e/narration.ts`, with the budget written down up front: phase 2 gate ≈ 2 keep-visuals runs + retries; phase 5 ≈ 1 fit run + 1 tamper run. Measured cost ranges are recorded in `docs/spikes.md` and in the render dialog's copy.
  - Per-clip beep correlation.
  - The PCM hash of the locked bus, not lossy MP4 bytes.
  - Loudness on decoded AAC.
  - Visual frame-prefix invariance for keep-visuals.
  - Header checks for the mic policy.

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Latency APIs are absent or inaccurate on some browser or device, especially Bluetooth. | High | MP4 mode uses one document clock. Per-route calibration is required on a new route, plus the manual offset. The sync promise is stated per S10-qualified setup. |
| Recording against the base MP4 is too limiting: visual edits block recording. | Medium | Clear copy. Phase-6 option to record against a fresh keep-visuals render. Fit mode adapts visuals afterwards anyway. |
| STT too slow, too large or unavailable on the runner. | Medium | S11 tries Parakeet, then whisper.cpp. Bounded timeout, cache, empty-VTT fallback, caption editor. Captions never block a render. |
| Loudness misses the target after AAC encoding. | Medium | Pre-limit with headroom, measure the decoded AAC, one bounded correction, otherwise fail loudly with the numbers. |
| The agent changes narration in fit mode. | Medium | `narration_modified` checks the effective audio graph against frozen-derived expectations. A failed run beats a wrong mix. |
| Take privacy gaps (other readers, runs). | Medium | Phase 1 scope enforcement on every path. Documented runner trust model. GC with race-safe reference checks. |
| Browser memory or quota on long takes. | Low–Medium | Worker streaming, IndexedDB from chunk 1, quota handling. S14. |
| Preview and render mix diverge. | Low | Shared `timeline.ts` and `duckPoints`. The phase-2 gate compares the preview mix rendered offline against the MP4. |

## 12. Owner questions (answers proposed by round 1; owner to confirm)

1. **Default render choice:** *Keep my visuals* preselected, after a duration and overflow preview, with the measured cost range shown for both options. Both reviewers agree.
2. **Bluetooth:** warn, and prompt calibration on first use of any new route. Don't block, and don't infer Bluetooth from device labels.
3. **Unused takes:** a 30-day grace after last reference, plus an explicit **Delete unused recordings**. Discarding a draft releases references but doesn't destroy recordings immediately.
4. **Captions provider:** local (Parakeet or whisper.cpp, per S11) by default. ElevenLabs transcription is a separate explicit opt-in, even when the TTS key exists.
5. **Share-page transcript:** offered in the publish dialog with a preview, off by default for recorded narration, and the choice is remembered. Published audio doesn't imply consent to searchable text.
6. **Take length:** keep 10 min / 50 MiB in v1. Longer takes raise memory, STT and run-time costs. The session ceiling isn't the binding limit.

## 13. Missing-piece checklist (each one is covered above)

- Mic denied or disconnected: §5.1, §2.1.
- Suspended or interrupted context: §2.1.
- Hidden tab: §5.3.
- Partial-upload retry: §5.1.
- Sign-out or account switch during recovery: §5.1.
- Preview link renewal during a take: none in MP4 mode; in iframe mode the take stops (§5.3).
- Narration after beats are deleted or reordered: recording is blocked with pending visual edits; after a render, narration is absolute-time and doesn't move.
- Muted or empty-track captions: §6.6.
- Cancellation: §2.1, §6.4.
- Global video-duration limit: hold-frame overrun is bounded by the existing max video duration.
- MCP URL ingestion: not in v1 (§7).
- Shortcuts in text fields and on non-Mac: §5.5.
- Draft expiry: §6.1.
- Autoplay gesture: §2.1.
- Revoice and narration ordering: §6.3.
- Device change mid-take: §2.1.

## 14. Review log

### Round 1, 2026-11-02 (Fable 5 high: 499 credits; Codex gpt-6.1-sol high: 191 credits)

**Taken** (claims checked against the code before adopting):
- **One narration bus instead of per-clip `data-va-layer` elements** (both). `validate()` requires layers to span the video, and `relayout()` resets them (`contract.ts:336-347,569-573`).
- **Single-clock sync design.** The iframe is opaque-origin (`CompositionPreview.tsx:236`), so its `performance.now()` can't be compared with the parent's (both). We record against the parent-document MP4 with `requestVideoFrameCallback` (Codex's comparison, made primary), with parent-stamped message timestamps as the fallback (Fable). Also: no `outputLatency` double-counting, `baseLatency` isn't input latency, and calibration is per route (Codex).
- **Recompute-and-verify guards** modelled on `checkRevoiced`, instead of filename exceptions (both). The fit guard checks the effective audio graph (Codex) and the full attribute set (Fable).
- **Fit uses mode `author` from the frozen edited draft.** There's no `revise` mode (`types.ts:260`), the reconciler restores the parent's archive (`reconciler.ts:195-198`), and TTS gets suppressed (Codex).
- **Narration cues as their own kind,** since `validate()` rejects them otherwise (`contract.ts:433-452`). VTT is required, so failure means an empty VTT (`types.ts:775`). Caption fixes are immutable revisions (Codex).
- **Takes outside `snapshotMedia`** (12 / 300 MiB cap, `media.ts:260-262`), hydrated by Blobs key, not signed URLs (`prepare-run.ts:182-197`) (both).
- **Take scope enforcement.** Any reader can load ready media today (`media.ts:231-233`) (Codex). Plus a **new reference-aware GC**, because none exists (`cleanup.ts`) (both). And a stored-bytes quota, because the 1 GiB quota covers unfinished uploads only (Codex).
- **Parakeet before whisper.cpp,** as hinted by `docs/spikes.md:231` (Fable). Bounded, cached, timed-out transcription (Codex).
- **Cleanup chain:**
  - order (declick before denoise, Fable);
  - per-take gain (Fable);
  - a true bypass;
  - explicit compressor units;
  - measuring the decoded AAC, since `hyperframes audio` doesn't measure the mix (Codex);
  - edge trim off in v1 (Codex; Fable's browser-side trim is kept as the future rule);
  - releasing the duck during pauses (Fable);
  - the 512-point automation cap (Codex).
- **Recorder** streams to a worker and IndexedDB from the first chunk (both), with transferable blocks, a ready-wait before treating a take as durable, and silent worklet output (Codex).
- **Data model:**
  - integer samples;
  - per-alternative alignment;
  - handle crossfades;
  - a separate peaks blob (the 10 KB estimate was wrong; it's about 225 KB Float32);
  - queryable media columns;
  - `voiceover` left as AI config, with the badge derived (Codex);
  - draft-expiry handling (Fable).
- **Local undo stack,** since only the newest revision survives (`edits.ts:208`) (Codex). Reviewers don't hear drafts, since drafts are author-only (`edits.ts:265`) (Codex).
- **Phase order:** storage and privacy, then upload-to-render, before recording; caption fixes in the first recording release; per-clip correlation and PCM-hash gates; a written gate budget (Codex).
- **Mic policy set in the edge functions too** (Fable). MCP uses media ids only, with no URL ingestion (Codex).
- **Plan facts corrected:** `data-loop` (it's native `loop`), the bridge's message list, `data-va-captions` (no such convention), mute semantics (`data-va-muted`), and publish-time transcription (publishing starts no run).

**Changed from a reviewer's suggestion:**
- **Bluetooth:** Fable suggested *requiring* calibration before Bluetooth takes, and Codex said not to infer Bluetooth from labels. We prompt calibration on **any new route**, which covers Bluetooth without detecting it.
- **Edge trim:** Fable proposed doing it in the browser in v1. Codex proposed disabling it. We disabled it for v1 and kept Fable's rule for when it's added.

**Not taken:**
- **Fable's "`outputLatency` / `getOutputTimestamp` unsupported in Safari."** Codex cites MDN (Safari 14.1+ / 18.4+). We feature-detect and let S10 decide, rather than designing around either claim.
- **Codex's "Compare MP4 recorder vs composition recorder" as an open choice.** We pick MP4 mode as primary (one clock, simpler) and keep the iframe as the S10 fallback, so phase 3 has a default to build.
