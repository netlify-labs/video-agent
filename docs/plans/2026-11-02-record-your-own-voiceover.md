# Record your own voice-over — plan

- **Status:** draft 1 (2026-11-02). Not reviewed yet. Next: phase 0 spikes, then review rounds per the planning workflow.
- **Owner decisions so far (2026-11-02 interview):**
  - **Recording:** a whole take first, then punch-in re-records over any range. It should feel like a video editor: recordings are clips on a Narration track that sits above Music.
  - **Re-render:** the user picks either a plain re-render (render-unchanged, visuals untouched) or "let the agent adapt", which may retime scenes to fit the narration.
  - **Captions:** recorded narration is auto-transcribed into timed captions and VTT.
  - **In scope for v1:** a mic level meter, device picker and countdown; audio cleanup; uploading an existing file instead of recording; and an option to keep the original AI voice-over or sound under the narration.
- **Builds on:**
  - [`2026-10-31-storyboard-editor-feedback-media.md`](2026-10-31-storyboard-editor-feedback-media.md): editor, drafts, render-unchanged, media.
  - [`2026-11-01-ideas-audio-skills-oauth.md`](2026-11-01-ideas-audio-skills-oauth.md): sound, music, AI voice-over.
  - SPIKES S2, S5, S7 and S9.

---

## 1. Goal and why

Today a video's narration can only come from the AI: Kokoro in the run, or ElevenLabs when a key is set. People want their own voice on their own product videos. It sounds like them, it carries a demo better, and it removes the "AI voice" feel from anything that ships externally.

The feature: **press Record, watch your video play, talk over it, and get a new version with your voice mixed in, ducked music, cleaned-up audio and real captions.** If a sentence comes out wrong, re-record just that sentence. If the narration runs long, either let it play over the existing visuals or let the agent stretch the scenes to fit.

Success looks like this:
1. A creator narrates a 60–90 s video in one sitting, fixes two flubs with punch-ins, and renders. The whole thing takes under 10 minutes, and the plain re-render costs about 34 credits.
2. The narration stays in sync with the visuals to within one video frame (≤ 33 ms at 30 fps) at every point, including after a punch-in.
3. The output meets the existing audio bar: speech is intelligible over the music, the mix is about −14 LUFS integrated, and captions are timed to words.
4. It works in current Chrome, Safari and Firefox on macOS, with a built-in mic or a USB mic.

Non-goals for v1:
- Multi-person or remote recording.
- Video recording (camera) or picture-in-picture.
- Pitch or voice effects.
- Real-time collaborative editing of the timeline.
- Recording on mobile. It may work, but it isn't tested or promised.
- Browser-side MP4 rendering. S7 rejected it, and rendering stays in the Agent Runner run.

## 2. User workflows

### 2.1 Record a whole take
1. On a finished version, the user opens **Edit → Narration** (or clicks **Record voice-over** on the Video page, which opens the editor at the Narration track).
2. **Setup panel:**
   - A mic picker (`enumerateDevices`, remembered per browser), a live input meter and a "say something" check that warns when the level is too low or clipping.
   - A **Headphones** toggle, on by default:
     - **On:** the video's own audio plays normally.
     - **Off:** playback is muted while recording (or ducked to −30 dB, user's choice) and browser echo cancellation is turned on, so the room mic doesn't record the video's own audio.
   - A **Keep original audio** choice: *Replace AI voice-over* (default; the AI voice track is muted but kept), *Keep it under my voice* (AI voice at −12 dB), or *Mute all original audio*.
3. The user clicks **Record**, sees a 3-2-1 countdown, and the video plays from the start while recording.
4. They can stop at any time. The take covers whatever they recorded. **Esc** discards the take; **Space** stops and keeps it.
5. The take appears as a clip on the **Narration** track, with its waveform, aligned to the video time it was recorded against.
6. The user can **play back the mix right away** in the browser: video, music (ducked), AI voice (per the choice above) and the new narration, all through the existing composition preview. No render is needed.

### 2.2 Punch-in (re-record a range)
1. On the timeline, the user selects a range (drag on the ruler), or puts the playhead somewhere and presses **R**.
2. **Pre-roll:** playback starts 2 s before the punch point (configurable 0–5 s), with the existing narration audible, so the user can match their tone. Recording is live only inside the punch range, or from the punch point until they stop.
3. The new take is laid on top. Where it overlaps, it wins: older clips are trimmed or split non-destructively, and their audio files are never modified.
4. A 20 ms crossfade at every edit point avoids clicks.
5. **Takes:** each clip remembers its alternatives. Right-click opens **Takes ▸ Take 3 / Take 2 / Take 1**, which swaps the take in place. Undo and redo cover every timeline action.

### 2.3 Arrange clips like an editor
- **Clip actions:**
  - Drag clips in time.
  - Trim either edge. Trimming moves `in`/`out` within the recording, which is non-destructive.
  - Split at the playhead (**S**) and delete (**Del**).
  - Set clip gain (−∞ to +12 dB) and fades.
- **Tracks:** each one has volume and mute, and Narration also has solo.
  - **Scenes:** read-only lane showing beat boundaries.
  - **Narration:** the user's clips.
  - **AI voice:** the existing per-beat clips.
  - **Music:** with a ducking toggle and amount.
- **Snapping:** to beat boundaries, other clip edges and the playhead (hold ⌥ to disable).
- **Zoom:** ⌘-scroll; the waveform redraws at the new zoom level.

### 2.4 Upload instead of record
- Drag an audio file (MP3, WAV, M4A, Ogg, and WebM/Opus once §5.2 lands) onto the Narration track, or pick one from the media library. It lands as a clip at the drop position, and everything else behaves the same as a recorded take.

### 2.5 Render
The user clicks **Render** and gets a choice:
- **Keep my visuals (fast, about 34 credits).** This is render-unchanged. Narration plays over the existing scenes. A clip that runs past the end of the video triggers a warning. The user can trim the clip, extend the last scene by holding its final frame (shown as an option), or switch to the agent option.
- **Let the agent fit the video to my narration (about 250 credits).** This is an authoring revise run. The agent gets the narration's word timings and may retime, extend or tighten scenes to match. **The agent never edits the narration audio.** That is a hard contract rule (§6.4).

Either way the result is a **new version n+1**, with mode `render_unchanged` or `revise` and `voiceover.source = 'recorded'`, captions transcribed from the narration, and the usual MP4, GIF, VTT and poster. Publication is per version and unchanged: a published older version keeps its slug until the user publishes the new one.

### 2.6 Edit captions afterwards
- The transcript is shown, and words can be corrected. Fixes keep their timings and only change the text; they're saved as an edit op, so no new transcription is needed.
- A misheard word can be fixed without a re-render if only the VTT changes. The VTT is a sidecar, but burned-in captions would need a re-render. §6.6 explains the split.

## 3. Constraints from the current system

These come from the 2026-11-02 code map.

| Fact | Where | Consequence |
|---|---|---|
| Every MP4 is rendered in an Agent Runner run (`hyperframes render` in `scripts/render-job.ts`). There's no function-side or browser render path (S7). | `src/domain/reconciler.ts`, `prompt.ts:303-354` | A plain re-render is a render-unchanged run, about 34 credits flat. |
| AI voice is one `<audio data-va-voice="<beat>">` per beat, ending inside the beat. | `contract.ts:372-401`, `video/AGENTS.md:129-204` | A narration that spans the whole video can't reuse `data-va-voice`. It needs a new root-layer role. |
| HyperFrames audio supports `data-start`, `data-duration`, `data-volume`, `data-media-start`, `data-playback-start` and `data-loop`. Every `<audio>` needs an `id`. | HyperFrames dist, `video/AGENTS.md` | Clips can reference a slice of a recording without re-cutting files (`data-media-start` = trim-in). Spike S12 confirms behaviour with many clips. |
| Music ducking is a `data-automation` volume lane computed from `data-va-duck`. | `contract.ts:468-526` | Extend the duck sources to narration clip ranges. |
| Audio media are accepted by content sniffing: MP3, WAV PCM, Ogg Vorbis/Opus, M4A/AAC. **WebM is rejected.** The limit is 50 MB / 10 min. | `src/lib/media/classify.ts`, `audio.ts:208` | Chrome `MediaRecorder` defaults to WebM/Opus. Recording to PCM (§5.1) avoids that. Uploads need a WebM/Opus path (§5.2). |
| Uploads over 4 MB use resumable sessions: 4 MB parts, 100 MB per session, 1 GB quota per user. | `src/domain/media-uploads.ts` | A 10-minute 24 kHz mono 16-bit WAV is 28.8 MB, which fits comfortably. |
| No STT on the AI Gateway. `hyperframes transcribe` fails on the runner (`whisper_unavailable`). | SPIKES S9 | Captions need a transcription path we bring ourselves (§6.6, spike S11). |
| The MP4 player (`Review.tsx`) exposes `currentTime`, `timeupdate` and `seeked`. The composition bridge sends `ready` and `time` only, with no play, pause or ended events. | `Review.tsx:89-126`, `src/preview/bridge.js` | Sync needs a precise clock. We add `playing`, `paused` and `ended` events to the bridge with frame timestamps, and use the bridge in the editor (§5.3). |
| Loudness is only normalized by the agent, on music (`normalize-audio --target=music --lufs=-14`). Voice WAVs aren't. | `prompt.ts:215,262` | Our run step must normalize narration deterministically, not through the prompt (§6.5). |
| Roles: `edit:create` and `media:upload` are Creator-only. | `policy.ts:47-86` | Recording needs both. Reviewers and viewers never see Record. |
| No `Permissions-Policy` header is set. | `netlify.toml`, edge functions | The microphone is allowed by default on the top-level origin. Pin `microphone=(self)` explicitly (§8) so a future header change doesn't silently break recording. |

## 4. Architecture overview

```
Browser (editor)                              Netlify Functions / DB / Blobs                Agent Runner run
────────────────                              ──────────────────────────────                ────────────────
Recorder (AudioWorklet, PCM)  ──WAV parts──▶  media upload session ─▶ media{kind:audio,
  + sync clock (preview bridge)                 role:narration-take, recordedAgainst}
Peaks (waveform) computed locally ──────────▶ media meta.json: peaks, duration, offsets
Timeline model (clips/tracks)  ──edit ops───▶ saveEdit → buildRev (immutable bundle rev)
Live mix preview (Web Audio)                    narration ops → contract HTML
                                     Render ──▶ renderEdit → version n+1 (render_unchanged | revise)
                                                 └─ reconciler starts run ───────────────▶ prepare-run: fetch takes,
                                                                                            cleanup chain, loudness
                                                                                           transcribe (whisper.cpp)
                                                                                           hyperframes check/render
                                                                                           finalize: mp4, vtt, narration.mp3
```

What goes where, and why:
- **Recording happens in the browser.** Only the browser has the mic. PCM through an AudioWorklet gives sample-accurate timing and no codec gaps (§5.1).
- **The timeline is edit ops on the existing draft system.** It inherits immutable revisions, undo by revision, CSRF, roles and render-unchanged for free. There's no new persistence model.
- **Processing happens in the run, not in a Function.** ffmpeg and whisper already work or can be installed there. Functions have tight time and size limits, and S9 says no audio work runs in a Function. The bytes the user recorded are never modified; cleanup produces derived files inside the run's bundle.
- **The live preview mixes in the browser with Web Audio.** Instant feedback without a render is what makes it feel like an editor.

## 5. Browser: recording, sync and preview

### 5.1 Recorder
- `getUserMedia({ audio: { deviceId, channelCount: 1, sampleRate: 48000?, echoCancellation, noiseSuppression: false, autoGainControl: false } })`.
  - Browser noise suppression and AGC are **off** by default. They pump the level and smear consonants, and we clean up deterministically in the run instead.
  - Echo cancellation follows the Headphones toggle: off with headphones, on without.
- `AudioContext` → `MediaStreamAudioSourceNode` → an `AudioWorkletNode('va-recorder')` that posts Float32 frames along with the **context sample position** of each block.
  - The worklet keeps a ring buffer, and the main thread writes chunks to an in-memory PCM store.
  - For takes over 2 minutes, chunks also go to IndexedDB so a crash or reload doesn't lose the take. Recovery is offered on the next editor load.
- On stop: resample to 24 kHz mono with an `OfflineAudioContext`, encode 16-bit PCM WAV (already accepted, so no classifier change is needed for recordings), compute peaks, and upload.
- **Why not MediaRecorder:**
  - Its start latency varies by 50–300 ms between browsers and runs.
  - It produces WebM in Chrome and Firefox, which we reject today.
  - It gives no per-sample timestamps.
  - PCM capture is the standard DAW approach and keeps sync exact.
  - The cost is larger uploads, about 2.9 MB per minute, which is fine with resumable sessions.
- **Level meter:** an `AnalyserNode` showing RMS and peak, with a clip indicator latched for 1 s.
  - Before recording, a 3 s "check level" pass shows a verdict: too quiet (< −40 dBFS RMS), OK, or clipping (≥ −1 dBFS peak).
- **Countdown:** 3-2-1 overlaid on the player. Recording starts at "1", so the worklet is already running before the playhead moves and nothing is clipped.

### 5.2 Upload instead of record
- Reuse `ui/src/lib/upload.ts` sessions.
- Add **WebM/Opus** to the classifier:
  - Detect the EBML header and `A_OPUS`/`A_VORBIS` codec IDs.
  - Probe duration with ffprobe in prepare-run, as other audio is today.
  - Add a fixture to `media.test.ts`.
- This also covers recordings people make in other tools.
- An uploaded file has no recording clock, so it gets placed where dropped (default 0) and the user aligns it by dragging. An optional **auto-align to AI voice-over** (cross-correlation against the AI voice track) is deferred to phase 5.

### 5.3 Sync clock (the hard part)
The goal is to know, for sample *k* of the take, which **composition time** *t* the viewer was seeing and hearing.

- **Player:** record against the **composition preview** (the editor's `CompositionPreview`), not the MP4.
  - The timeline edits the composition, so its clock is the clock we render against.
  - It also plays the AI voice and music exactly as the run will.
  - The MP4 path (`Review.tsx`) is used for the Video page's **Record voice-over** entry only as a launcher. It opens the editor.
- **Bridge additions** (`src/preview/bridge.js`):
  - Post `playing{time, perfNow}`, `paused{time, perfNow}`, `ended{time, perfNow}` and `seeked{time, perfNow}`.
  - Keep posting `time` every frame, now including `perfNow` (`performance.now()` in the iframe; it's the same clock as the parent because they share a timeline origin).
  - Add a `playFrom{time}` command for pre-roll.
- **Mapping:**
  - At record start, the parent stores `ctxStartPos` (the worklet's sample position) and the mapping `perf ↔ ctx` from `AudioContext.getOutputTimestamp()`.
  - Every `time{time, perfNow}` message gives a (composition time, perf time) pair, and therefore a (composition time, context sample) pair.
  - We fit `t = a + b·sample` by least squares over the take. *b* should be 1/sampleRate; if the fit says otherwise, the player drifted, and we split the take at the drift point and warn.
  - The clip's `start` is *t* at sample 0, corrected by:
    - **Input latency:** `MediaStreamTrack.getSettings().latency`, falling back to `AudioContext.baseLatency`.
    - **Output latency:** `AudioContext.outputLatency`. The user hears the video late, and their words follow what they heard.
- **Calibration (optional, recommended once per device):**
  - A 4-beep loopback test, played through speakers and picked up by the mic, measures round-trip latency.
  - It's stored per device in `localStorage`, and the user can also nudge it with a **Sync offset ±** slider while previewing.
  - Spike S10 decides whether calibration is needed by default.
- **Pause while recording** stops the take. A take is continuous composition time by construction, which keeps the model simple.

### 5.4 Live mix preview
- **The problem:** the composition preview iframe plays the *current* composition, which has no narration until the draft is saved.
- **The fix:** the parent mixes narration clips itself, using Web Audio `AudioBufferSourceNode`s scheduled against the bridge clock (`start(when, offset, duration)` with crossfades).
  - It also tells the iframe to apply track volumes and mutes through a new `mix{tracks}` command, which sets `volume` on the iframe's `<audio>` elements.
  - Ducking is previewed by applying the same `duckPoints` math in the parent to the music element volume.
- **Accuracy:** this is a preview, so ±1 frame is fine. The authoritative mix is the run's render (§6).

### 5.5 Timeline UI
- `ui/src/components/timeline/`:
  - `Timeline.tsx`: canvas-based, virtualised rows.
  - `Track.tsx`, `Clip.tsx`: waveform from peaks, trim handles, fades.
  - `Ruler.tsx`
  - `Playhead.tsx`
  - `useTimelineModel.ts`: a pure reducer over clips plus an undo stack, unit tested.
- The model is a pure TS module, `src/lib/timeline.ts`, shared by the UI and the server-side contract builder, so overlap resolution can't diverge between preview and render.
- **Keyboard shortcuts:**
  - Space: play/pause
  - R: record or punch
  - S: split
  - Del: delete
  - ⌘Z / ⇧⌘Z: undo / redo
  - ←/→: nudge 1 frame; ⇧ nudges 10 frames
- **Accessibility:**
  - Every action is also available from a clip menu.
  - Clips are focusable, and arrow keys move them.
  - The recorder announces its state through `aria-live`.

## 6. Server and run: data, contract, render

### 6.1 Data model
- **Takes are media rows** with no new table: `kind: 'audio'`, plus `meta.json` fields:
  `role: 'narration-take'`, `recordedAgainst {jobId, n, editId?, rev?}`, `sampleRate`, `durationMs`, `peaks` (an array of 512-sample min/max pairs, ~10 KB for 10 min at that resolution), `device {label hash only}`, `sync {fitResidualMs, latencyMs, calibrated}`.
  - Uploaded files get `role: 'narration-upload'`.
- Takes are hidden from the general media library list by default, with a **Show recordings** filter. They're deleted the same way as other media (soft delete; versions keep their bytes).
- **Edit ops:** add one op, `narration`, that carries the whole Narration track state. The track is replaced wholesale on each save; it's small, and per-clip ops would make overlap resolution order-dependent.
  ```ts
  type NarrationOp = {
    op: 'narration'
    clips: Array<{
      id: string              // stable clip id (uuid)
      mediaId: string         // take or upload
      start: number           // composition seconds
      in: number              // seconds into the recording
      out: number             // seconds into the recording (> in)
      gainDb: number          // -60..+12
      fadeIn?: number         // seconds, default 0.02
      fadeOut?: number
      takes?: string[]        // alternative mediaIds, most recent first (UI only)
    }>
    tracks: {
      narration: { volume: number, muted: boolean }
      aiVoice:   { mode: 'replace' | 'under' | 'keep', volume: number }
      music:     { duck: boolean, duckDb: number }   // default duck on, -12 dB
      original:  { muteAll: boolean }
    }
    cleanup: { denoise: 'off' | 'light' | 'strong', trimEdges: boolean, normalize: boolean }
  }
  ```
  - Validation is zod in `src/schemas.ts`. Clips must not overlap after resolution, because the reducer already resolved them. Every `mediaId` must be a ready audio item owned by this user or by the video's owner. There are at most 200 clips.
- **Version fields:**
  - `versions.voiceover` gains `source: 'ai' | 'recorded' | 'mixed'`.
  - `narration` (jsonb, the resolved op) is stored on the version so the render is reproducible and the editor can reopen it.
  - The migration adds one nullable jsonb column, generated with `npm run db:generate` (new migration only).

### 6.2 Contract (composition HTML)
- Each resolved clip becomes a root-layer element:
  ```html
  <audio id="va-nar-<clipId>" data-va-layer="narration" data-va-clip="<clipId>"
         src="assets/narration/<mediaId>.wav" data-start="12.480" data-duration="3.210"
         data-media-start="0.840" data-volume="1.0" data-va-duck></audio>
  ```
- Fades are written as a `data-automation` volume lane, the same mechanism as ducking, so they don't need a new attribute.
- **AI voice modes:**
  - *replace* sets `data-volume="0"` on every `data-va-voice` element and keeps the level in `data-va-volume`, like mute today.
  - *under* sets it to the chosen level.
  - *keep* leaves it unchanged.
- **Music ducking:** `duckPoints` (`contract.ts:468-526`) gets narration clip ranges as an extra source, so speech-over-music gets the same ducking curve AI voice gets.
- **Contract checks** (`contract.ts`), each with a unit test:
  - narration elements are direct children of the root;
  - ids are unique;
  - `data-start + data-duration ≤ root duration`, unless the hold-last-frame extension is on;
  - `src` is under `assets/narration/`;
  - `data-media-start + data-duration ≤ take duration`.
- `buildRev` (`edits.ts:192-304`) applies the `narration` op to produce the revision's HTML, exactly as `audio` and `voice` ops do today.

### 6.3 Render: keep my visuals (render-unchanged)
- `renderEdit` freezes the revision as today and adds `frozen.narration: {mediaIds[], cleanup}`.
- `buildRenderUnchangedPrompt` gains a narration step between prepare-run and check, so the run order is:
  1. **prepare-run:** fetch each referenced take through signed `/media/<id>/file` URLs (S5 path), verify sha256, and ffprobe it.
  2. **narration process** (`scripts/narration.ts`, new and deterministic; the agent only invokes it):
     - Decode to 48 kHz mono float.
     - **Cleanup:**
       - Always: a high-pass at 80 Hz.
       - `light`: ffmpeg `afftdn=nr=10:nf=-40`.
       - `strong`: `arnndn` with a bundled RNNoise model file.
       - Always: a de-click and a gentle 2:1 compressor above −24 dBFS.
     - **Edge trim:** strip silence below −45 dBFS from each *clip's* in/out edges only, by moving `in`/`out` and `start` together so sync is preserved. Silence inside a clip is never removed.
     - Write `assets/narration/<mediaId>.wav`. The same file serves every clip that references the take, with `data-media-start` selecting the slice.
     - **Loudness:** measure the narration bus (all clips rendered on the timeline) with two-pass `loudnorm`, apply one gain so speech sits around −16 LUFS short-term, then let the music duck under it. The final mix is checked with `hyperframes audio` for about −14 LUFS integrated, with true peak ≤ −1 dBTP. A failed check fails the run with the measured values; it is not left to the prompt to fix.
  3. **transcribe:** §6.6.
  4. `hyperframes check`, then `render-job`. render-job's changed-files guard (`render-job.ts:84-103`) learns to allow `assets/narration/*` and `summary.json` captions.
- Cost: still the flat render-unchanged rate, about 34 credits plus the narration step's seconds. Spike S11 measures how long whisper takes.

### 6.4 Render: let the agent fit the video
- This is a revise run (`mode: 'revise'`).
- **Prompt input:** the narration as **locked audio**. That's the clip list, the transcript with word timings, and the text "narration is fixed: do not move, cut, re-time or re-synthesize any `data-va-layer=narration` element; adjust scene durations, beat boundaries and animations so visuals match what is being said".
- **Run order:** the narration step (§6.3 step 2) runs **before** the agent works, so the agent sees final timings.
- **Guard:**
  - render-job checks that every narration element's `src`, `data-start`, `data-duration` and `data-media-start` are byte-identical to the frozen narration manifest. Any change fails the run with `narration_modified`.
  - Root duration may grow to at least the end of the last clip.
- **The agent may:**
  - extend or shorten beats;
  - move AI-voice clips, or drop them in *replace* mode;
  - add hold frames;
  - retime text and animations.
- Cost: an authoring run, about 250 credits. The UI shows the estimate before confirming, like plan runs do.

### 6.5 Why processing is deterministic code, not prompt
- Loudness today is a prompt instruction, and only music gets normalized.
- Narration quality is the whole point of this feature, so cleanup, trim and loudness are a script with fixed parameters, unit tests on fixtures and measurable output. The agent only runs it.
- The same script runs in both render modes, so "fast" and "agent" outputs sound the same.

### 6.6 Captions from transcription
- **Primary path:** whisper.cpp on the runner. A pinned binary plus the `base.en` model (~140 MB) are cached in the runner image or downloaded once per run with sha256 pinning.
  - It produces word timestamps (`-ml 1 -owts` / JSON output).
  - It runs on the processed narration bus, then maps word times to cues using the existing `voiceCaptions` phrase logic (`src/lib/voice.ts:313-332`) to keep the caption style.
  - Spike S11 measures accuracy, speed on the runner CPU and the cold-download cost. If base.en is too slow, use `tiny.en` for drafts and `base.en` on publish.
- **Optional path:** when `ELEVENLABS_API_KEY` is set, ElevenLabs Scribe STT, matching the TTS behaviour. This is configurable in settings: `transcriptionProvider: 'whisper' | 'elevenlabs' | 'off'`.
- **Language:** English by default. A `language` setting per video passes `-l` to whisper and switches to a multilingual model. Multilingual is deferred to phase 5.
- **Caption fixes:** a `captions{cues:[{start,end,text}]}` edit op overrides the text and keeps the timings.
  - If the video burns captions in (`data-va-captions` visible), a fix needs a re-render.
  - If captions are VTT-only (the default today: captions off, VTT sidecar), the fix is applied by **re-publishing the VTT without a render**, through a small `PATCH /versions/:n/captions` that rewrites `captions.vtt` in Blobs and bumps a `captionsRev`.
- **No-transcription fallback:** if transcription fails or is off, the render still succeeds, the VTT is left out, and the version shows a "No captions: add them" call to action.

### 6.7 Outputs
- The version gets the usual mp4, gif, poster and vtt, plus `narration.mp3` (192 kbps CBR, the processed narration bus alone) as a downloadable asset, and `transcript.txt`.
- The share page gains a **Transcript** disclosure when a transcript exists, which helps accessibility and SEO on public pages.

## 7. API and MCP

- **New or changed REST endpoints**, documented in OpenAPI and checked by `openapi:check`:
  - The existing media upload sessions are used for takes, with `role` passed in the session create body.
  - `GET /api/v1/videos/:id/versions/:n/narration` returns the resolved clips, tracks and the transcript with words.
  - `PATCH /api/v1/videos/:id/versions/:n/captions` applies a caption text fix (VTT-only path).
  - The edit draft endpoints accept the `narration` and `captions` ops, and `renderEdit` gains `mode: 'keep_visuals' | 'fit_to_narration'`.
- **MCP** (`src/mcp.ts`), in phase 5:
  - `add_narration`: an agent uploads an audio file by URL or media id and places it.
  - `get_narration`
  - `render_with_narration {mode}`
- Recording itself is browser-only.
- **Skills zip:** add a `narration.md` page.

## 8. Security, privacy, roles

- **Roles:** Record, Upload and Render need Creator with `edit:create` and `media:upload`. Reviewers can listen to takes in a draft they can view, but can't record.
- **Mic permission:**
  - Pin `Permissions-Policy: microphone=(self)` in `netlify.toml` for app routes.
  - Public share and embed routes keep `microphone=()`.
  - The preview iframe never gets mic access, because recording happens in the parent.
- **Voice data is personal data:**
  - Takes live in the private `media` Blobs store and are served only through signed URLs (600 s).
  - Discarded takes (never placed, or replaced and not in any version) are hard-deleted after 30 days by the existing media GC, or through **Delete unused takes** in the UI.
  - `narration.mp3` follows the version's publication: public only if the version is published.
- **Abuse:**
  - Per-user upload quota applies (1 GB).
  - Take length is capped at 10 min by the existing audio limit.
  - Clip count is capped at 200.

## 9. Phases and dependencies

Phase 0 is spikes; nothing ships. The rest of the phases are built in order, and each one ends with a live gate.

| Phase | Contents | Depends on | Live gate |
|---|---|---|---|
| **0: spikes** | S10 sync accuracy (Chrome, Safari, Firefox; built-in and USB mic; headphones and speakers; with and without calibration). S11 whisper.cpp on the runner (speed, accuracy, cold cost). S12 HyperFrames with 50+ root `<audio>` clips using `data-media-start` + automation, plus render parity with the browser preview. S13 the cleanup chain on 5 real recordings (A/B against raw). S14 AudioWorklet capture memory over 10 min, plus IndexedDB recovery. | — | `SPIKES.md` S10–S14 written up with numbers. |
| **1: record a take** | Recorder, setup panel (meter, device, headphones, countdown), bridge events, take upload as WAV, peaks, `narration` op with a single clip, contract + `buildRev`, live mix preview, keep/replace original. | 0 | A 60 s take in Chrome and Safari, saved as a draft, previewed in sync (S10 threshold). |
| **2: render (keep visuals)** | `scripts/narration.ts` (cleanup, trim, loudness), whisper transcription, render-unchanged prompt step, changed-files guard, `narration.mp3` + transcript outputs, version fields + migration. | 1 | One render-unchanged run gives −14 ± 1 LUFS and true peak ≤ −1 dBTP, captions within 150 ms of words, and narration in sync within 1 frame (clap test). |
| **3: timeline editor** | Multi-track timeline, punch-in with pre-roll, overlap resolution in `src/lib/timeline.ts`, takes, split/trim/move/gain/fades, snapping, undo/redo, keyboard + a11y, IndexedDB recovery. | 1 (UI), 2 (render) | Three punch-ins on a 90 s video render without clicks, sync holds, and the takes switcher works. |
| **4: fit to narration** | Agent revise mode with locked narration, guard `narration_modified`, cost confirmation, hold-last-frame option for keep-visuals. | 2 | One fit run where narration runs 20% longer than the visuals: scenes extend and audio is byte-identical. |
| **5: upload + polish** | WebM/Opus classifier, upload to track, auto-align (cross-correlation), caption fix endpoint + editor, MCP tools, skills page, transcript on share page, multilingual. | 2 (upload), 3 (UI) | MCP `add_narration` + render through the API; upload of a Chrome WebM file. |

## 10. Testing

- **Unit (vitest):**
  - `timeline.ts` reducer: overlap resolution, split, trim, undo. Property tests: total covered time is preserved, and no overlaps after resolve.
  - Sync fit math: synthetic drift and latency.
  - WAV encoder.
  - Peaks.
  - Contract builder and checks for narration elements.
  - Duck sources.
  - The `narration` op schema.
  - Migration snapshot.
- **Script tests:** `scripts/narration.ts` on fixtures in `test/fixtures/narration/` (quiet, clipping, noisy room, long silence edges). Assert LUFS and true peak via ffmpeg `ebur128`, that edge trim preserves sync (sample offsets), and that internal silences are untouched.
- **UI:** Playwright on the mock build, using a fake mic (`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=fixtures/count.wav`) in Chromium.
  - A take with known beeps at known times lands at the right `start` within 1 frame.
  - Punch-in replaces exactly the selected range.
- **Live gates:** `scripts/e2e/narration.ts`, about 34 credits plus one fit run of about 250 credits in phase 4.
  - Uploads a fixture WAV as a take, places 3 clips, renders keep-visuals, and downloads the MP4.
  - Verifies sync by cross-correlating the MP4 audio against the expected timeline, and checks LUFS and the VTT.

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Browser output latency is mis-reported, especially Bluetooth headphones at 150–250 ms, so the take lands late. | High with BT | Calibration beep test. Bluetooth is detected from the output device label and prompts calibration. Plus the ± sync slider. S10 measures this. |
| Safari AudioWorklet or `getOutputTimestamp` quirks. | Medium | S10 covers Safari. Fallback is a `timeupdate`-based fit with a wider tolerance and a calibration prompt. |
| whisper too slow or too big for the runner. | Medium | S11. tiny.en fallback, ElevenLabs path, captions optional. Never block the render on captions. |
| The agent edits the narration in fit mode despite instructions. | Medium | A hard guard in render-job with byte-identical attributes. The run fails rather than shipping a wrong mix. |
| Speaker bleed without headphones causes echo or doubled audio. | Medium | The Headphones toggle defaults to on and explains why. Without headphones, AEC is on and playback is muted or ducked while recording. |
| 200 root `<audio>` elements slow HyperFrames render. | Low | S12 measures this. If it's slow, the run pre-mixes the narration bus into one WAV and uses a single `<audio>`, keeping per-clip data in the manifest only. |
| Preview and render mix diverge (ducking, fades). | Low | One shared `src/lib/timeline.ts` and duck math. The phase-2 gate compares them by cross-correlating the preview mix rendered offline against the MP4 audio. |

## 12. Open questions for the owner

1. **Default render choice:** should *Keep my visuals* be preselected? The proposal is yes: it's cheap and predictable.
2. **Bluetooth:** is it enough to warn and offer calibration, or should Bluetooth be blocked for recording? The proposal is to warn.
3. **Unused takes:** is 30 days the right retention for unused recordings, or should unused takes be deleted when the draft is discarded?
4. **Captions provider default:** whisper on the runner (no key, slower), or ElevenLabs whenever the key exists? The proposal is whisper always, with ElevenLabs opt-in.
5. **Share page transcript:** on by default for published videos with recorded narration?
6. **Upload limits:** is 10 min per take enough? A longer take needs a higher audio limit (the session cap of 100 MB already allows about 34 min at 24 kHz mono).
