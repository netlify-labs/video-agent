# RNNoise model for the heavy cleanup preset

`sh.rnnn` is the RNNoise model ffmpeg's `arnndn` filter loads for the `heavy` narration cleanup preset
(`src/lib/narration-cleanup.ts`, docs/spikes.md S13). It is vendored so a run never downloads it.

| Field   | Value                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| Source  | [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models), `somnolent-hogwash-2018-09-01/sh.rnnn`    |
| Commit  | `3eee541a283fd3b8f81b85b1748e3b9ccbefa04d`                                                                     |
| sha256  | `70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0` (`rnnoiseModelPath()` checks it before use) |
| Size    | 297,646 bytes (rnnoise-nu model file version 1)                                                                |
| Intent  | Speech (not laughter or other human sounds) in a reasonable recording room: fans, AC, computers                |
| License | Not subject to copyright, per the repository README; the RNNoise code that reads it is BSD-3-Clause            |

The repository README says: "With the exception of the tools/ directory and this file, none of this work is
creative and thus none of it is subject to copyright." The model is the trained weights only, so it carries no
licence terms. Of the five models there, this one's intent (speech over recording noise) matches narration; the
`bd` model ("voice", which also keeps laughter) measured within 0.7 dB SNR of it on the S13 fixtures.

Changing the model changes heavy's output: update `RNNOISE_MODEL` and bump `NARRATION_PIPELINE`.
