# Your own voice-over

Creators can narrate a video themselves: open **Edit → Narration**, record while the video plays (or drop in an
audio file), re-record any stretch, and render. **Keep my visuals** re-renders the same picture with your voice (a
render-unchanged run); **Fit the video to my narration** lets the agent retime the scenes to your words (a full
run, and it always replaces the AI voice-over). Captions come from your recording.

- **Each take is reviewed before it goes on the timeline.** Stopping (Space) leaves the take in the Record panel. It
  shows its length and where it lands, and you can play and scrub it against the picture. Then you choose:
  - **Add to timeline** (Enter) puts it on the Narration track.
  - **Record again** throws it away and records that stretch again.
  - **Keep recording from here** punches in from where a take stopped early, and you review the joined take.
  - **Discard** (Esc) drops it.
  - **Download** saves the take as stored, named like `lumen-v1-take-3.wav`. A recorded take is a 24 kHz mono WAV,
    about 2.9 MB a minute. Where the browser can encode AAC, there's also a smaller M4A made in the browser (96 kbps,
    about 0.7 MB a minute). A selected narration clip has Download too.
- **Each track has its own +.** What it adds depends on the track:
  - **Narration** takes your voice: Record, Upload a file, From the library, Recordings for this video.
  - **Music** sets or replaces the video's music bed: Find music (Openverse), From the library, Upload a file. The bed
    spans the whole video, with the track's level, mute and **Duck** under narration. Even a video made without music
    gets one, and it renders without an agent run.
  - **AI voice: Generate** goes to the video's page to ask for a revision with AI voice-over.
  - **Add audio** under the timeline asks **Add to: Narration / Music**. It defaults to the track you used last;
    Openverse music defaults to Music, and recordings go to Narration only.
  - A file dropped on a lane goes to that lane: a clip on Narration, the bed on Music.
- **Recording needs HTTPS** (browsers only give the microphone to secure pages; the setup page checks it) and the app
  sends `Permissions-Policy: microphone=(self)`. Share, embed and preview pages never get the microphone.
- **Where recordings live:** in this project's Netlify Blobs (`media` store), like other uploads. A raw recording is
  readable by the person who recorded it and by admins. Once a recording is used on a video (on the Narration track
  of a version, or of its recorder's saved draft), Creators who can see that video can hear and re-cut it. Reviewers
  and viewers only ever get the rendered video and its `narration.mp3`, never the raw takes. Unused recordings stay
  private.
- **Retention:** a recording that nothing uses any more is deleted 30 days after its last use (or right away with
  **Delete unused recordings** on the Media page). Each person can store up to 2 GiB of recordings by default.
  Screen recordings (for demos) follow the same rule: deleted 30 days after upload if no video used them, or 30 days
  after the last video using them was deleted, together with their pointer trace; they have their own 2 GiB budget
  per person, set next to the voice recordings' on the Admin page.
- **Transcription** runs inside the render, locally, with NVIDIA's
  [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) model (CC-BY-4.0) through HyperFrames;
  nothing leaves the run. An admin can switch transcription to ElevenLabs (it then sends the narration to ElevenLabs;
  this is separate from using ElevenLabs voices) or turn it off.
- **Admin settings** (Admin page, no redeploy): turn recorded voice-over off for everyone, choose the transcription
  provider, and set the per-person recording quota.
- As with every upload here, agent runs can read the project's storage (see the [trust model](deploy.md#trust-model-plainly)), so app-level
  privacy is between people using the app, not a wall against runs.
