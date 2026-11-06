# S10 owner checklist: hardware matrix (Chrome, Safari, Firefox on macOS)

The automated run (Playwright, synthetic mic) proved the pipeline. It can't measure real latency. This checklist does:
real mics, real speakers and headphones, and a person clapping. Plan it as one sitting per browser, under 30 minutes
each. The page saves every result to `docs/spikes/s10/out/`, and `analyze.ts` turns those files into the tables for
`docs/spikes.md`.

## Once (5 min)

1. In the repo: `docs/spikes/s10/make-media.sh`. This writes `docs/spikes/s10/media/` (about 125 MB, git-ignored; the
   10-minute MP4 and stems are generated, never committed).
2. Start the server and leave it running: `npx tsx docs/spikes/s10/server.ts` → `http://127.0.0.1:4310/`.
3. Room: quiet. Laptop volume about 50%. Close other tabs that play audio. Turn off macOS "Voice Isolation" /
   mic modes in Control Centre (they post-process the mic).
4. Hardware on the desk: built-in mic + speakers, a USB mic (or USB interface), wired headphones, Bluetooth
   headphones (AirPods or similar).

## Labels

Type a **Setup label** before each block. Use the form `<browser> / <input> / <output>`, for example
`safari / builtin-mic / builtin-speakers` or `chrome / usb-mic / airpods`. Calibrations are stored per label (in
the page's localStorage), and every take report includes the latest (a), (b) and (c) offsets for that label. Pick
the input in **Input**, and keep echoCancellation, noiseSuppression and autoGainControl **unchecked** (the plan's
defaults) unless a step says otherwise.

## Per browser (Chrome, then Safari, then Firefox): about 28 min

Open `http://127.0.0.1:4310/` in that browser. Allow the microphone when asked. In Safari, set Settings → Websites →
Microphone → 127.0.0.1 → Allow, so it doesn't ask before every take.

| # | Setup label (output route) | Mode | Do this | Time |
|---|---|---|---|---|
| 1 | `<b> / builtin-mic / builtin-speakers` | — | **API matrix**. | 0.5 min |
| 2 | same | loopback | **Calibrate (a)** three times. Stay silent; it plays 8 clicks. Each run should show 8/8. | 1.5 min |
| 3 | same | loopback | **Calibrate (b)** twice. Clap sharply on each white flash (8 per run). Watch the picture, not the clock. | 1.5 min |
| 4 | same | loopback | **Take 10 min**. Hands off, tab visible, screen awake (System Settings → Lock Screen: never). This is the drift, residual, memory and stop → upload run. | 10.5 min |
| 5 | same | loopback | **Take 30 s**. Halfway through, switch to another tab and back. Expect stop reason `hidden`. | 0.5 min |
| 6 | same | loopback | **Take 30 s**. Halfway through, **reload the page**. Then **List recoverable takes**: expect one take with about 15 s and `runningHashOk: true`. | 1 min |
| 7 | `<b> / usb-mic / builtin-speakers` | loopback | Pick the USB mic in Input. Run **Calibrate (a)** twice, **Calibrate (b)** once, then **Take 30 s**. During a second **Take 30 s**, unplug the USB mic: expect `devicechange` or `track-ended`. | 3.5 min |
| 8 | `<b> / builtin-mic / wired-headphones` | headphones | Headphones on. **Calibrate (b)** twice (claps only; nothing leaks to the mic). Then switch Mode to loopback, hold one earcup against the laptop's mic (left of the keyboard on most MacBooks) and run **Take 30 s**. That is the physical beep loopback through the headphone route. | 2.5 min |
| 9 | `<b> / builtin-mic / bluetooth-headphones` | headphones | Bluetooth headphones connected as output, built-in mic as input. **Calibrate (b)** twice. Then the earcup-on-mic loopback **Take 30 s**, as in row 8. | 2.5 min |
| 10 | `<b> / bluetooth-mic / bluetooth-headphones` | headphones | Pick the headphones' own mic in Input (macOS switches them to the low-quality headset profile; note it). **Calibrate (b)** once. Then **Take 30 s** and clap on all 8 flashes: the claps are matched to flashes like beeps, so this measures the Bluetooth input end to end. | 1.5 min |
| 11 | any | — | **Audition memory** once. | 0.5 min |
| 12 | `<b> / builtin-mic / builtin-speakers` | loopback | Move the **(c) manual offset** slider to the value you'd pick by ear: play a **Take 30 s** with the earcup or speakers and adjust until beeps feel on the flash. It is the manual-only candidate. | 2 min |

Notes while running:

- Each take posts its report automatically. **Download last report** also saves it to Downloads. Keep that as a
  backup if the server wasn't running.
- A take that stops early shows its stop reason in the status line (`residual`, `slope`, `stall`, `seek`, `hidden`,
  `devicechange`, `track-ended`). Unexpected stops are results too: don't retry them away. Note what happened.
- Safari has no `performance.memory`. For row 4, also note the Safari Web Content process memory from Activity
  Monitor at the end of the 10-minute take, and add it to the label of the next take (for example
  `… / mem=410MB`).
- Firefox: if **Calibrate (a)** finds fewer than 4 clicks, raise the volume and run it again.

## Afterwards (2 min)

```sh
npx tsx docs/spikes/s10/analyze.ts               # plain tables
npx tsx docs/spikes/s10/analyze.ts --markdown    # same tables as Markdown, for docs/spikes.md
```

Paste the Markdown into the "Pending: owner hardware matrix" subsection of S10 in `docs/spikes.md` (replace the
pending list), and zip `docs/spikes/s10/out/` somewhere durable (it's git-ignored).

## What the tables settle

- **Calibration default.** The "Calibration repeatability" table gives (a) vs (b) spread per route. "b − a" shows
  whether the speaker loopback (a) transfers to headphones. Rows 8 and 9 give the headphone takes' errors with the
  (a) value from row 2.
- **Residual-stop threshold.** "Residual stop" gives the largest residual over clean takes. Pick a threshold
  comfortably above it (the proposal is 10 ms).
- **Qualified setups.** The "Qualified for <= 1 frame" table lists every setup and calibration where all start,
  middle and end errors were within 33.3 ms.
- **Worklet vs MediaRecorder.** The "MR offset" column is where MediaRecorder's decoded sample 0 sits against the
  worklet take (start delay plus codec priming). Each take report also has `mediaRecorder.startDelayMs`.
- **Memory.** The heap column for the 10-minute take, and the audition table.
- **Iframe fallback.** Needed only if a browser fails a muted-MP4 take (no rVFC anchors, `stall` stops, or a
  monitor that can't hold sync). Note any such failure.
