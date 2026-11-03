# Narration fixtures (S13)

Synthetic narration takes for the cleanup chain (`src/lib/narration-cleanup.ts`, `docs/spikes.md` S13) and the
phase-2 `scripts/narration.ts` tests. **No real person's voice is in them**: every voice is macOS text-to-speech
(`say`), and every recording condition is simulated with ffmpeg filters and seeded noise. They are free to use
under the repo's license.

All files are 24 kHz mono PCM16 WAV, written with ffmpeg's bitexact flags, 2.98 MB in total.
`sh spikes/s13/make-fixtures.sh [ffmpeg]` rebuilds them (macOS only). The ffmpeg steps are deterministic but `say`
isn't quite (some voices' timing varies by a few hundred ms between runs), so a rebuild differs slightly: the
committed files are the reference, and S13's numbers are measured on them. Each spoken take has 0.5 s of lead-in,
0.6 s of tail and `[[slnc]]` pauses, so there are gaps to measure room tone in.

| File                   | Voice    | Length | Simulates                          | How (speech filter; noise bed)                                                                                                        | Measured (ebur128)        |
| ---------------------- | -------- | ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `quiet-laptop.wav`     | Samantha | 10.1 s | quiet room, laptop mic, low level  | `highpass=f=150,lowpass=f=7000,aecho=0.8:0.6:23\|41:0.25\|0.15,volume=-17dB`; `anoisesrc=c=pink:a=0.0006:s=11`                        | -40.6 LUFS, -24.9 dBTP    |
| `noisy-room.wav`       | Daniel   | 10.5 s | noisy room with a fan              | `volume=-4dB`; pink `a=0.004:s=21` + brown `a=0.01:s=22` + `sine=f=120` ×0.006 + `sine=f=240` ×0.002                                  | -23.3 LUFS, -6.7 dBTP     |
| `usb-hot.wav`          | Karen    | 10.0 s | USB mic, clean and hot             | `volume=2dB`; `anoisesrc=c=white:a=0.00008:s=31`                                                                                      | -15.2 LUFS, -1.4 dBTP     |
| `near-clip.wav`        | Moira    | 9.1 s  | input gain far too high            | `volume=14dB,asoftclip=type=tanh,volume=-0.1dB`; `anoisesrc=c=pink:a=0.0004:s=41`                                                     | -7.5 LUFS, +2.0 dBTP      |
| `sibilant-headset.wav` | Tessa    | 10.7 s | harsh headset mic (loud esses)     | `treble=g=8:f=6000,volume=-6dB`; `anoisesrc=c=white:a=0.0006:s=51`                                                                    | -22.6 LUFS, -8.4 dBTP     |
| `silence-only.wav`     | none     | 3.0 s  | a take with no speech (room tone)  | `anoisesrc=r=24000:c=pink:a=0.0008:s=61:d=3`                                                                                          | -70.0 LUFS, -63.3 dBTP    |
| `punch-quiet.wav`      | Rishi    | 4.2 s  | a quiet take punched into…         | `volume=-20dB`; `anoisesrc=c=pink:a=0.0008:s=71`                                                                                      | -38.1 LUFS, -21.4 dBTP    |
| `punch-loud.wav`       | Rishi    | 4.5 s  | …a loud take of the same narration | `volume=0dB`; `anoisesrc=c=pink:a=0.0008:s=72`                                                                                        | -18.8 LUFS, -1.0 dBTP     |

Speech and noise are mixed with `amix=inputs=2:duration=first:normalize=0`; every noise source runs at
`r=24000`. The exact commands, including the spoken text, are in `spikes/s13/make-fixtures.sh`.
