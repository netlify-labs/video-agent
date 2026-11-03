#!/bin/sh
# Builds the synthetic narration fixtures in test/fixtures/narration/ (S13). Every voice is macOS `say` (no real
# person's voice); every degradation is ffmpeg with fixed noise seeds. Output: 24 kHz mono PCM16 WAV, bitexact.
# `say` timing varies slightly between runs, so a rebuild isn't byte-identical; the committed files are the reference.
# Usage: sh spikes/s13/make-fixtures.sh [ffmpeg]   (macOS only: needs `say`)
set -eu
FF=${1:-ffmpeg}
OUT=$(cd "$(dirname "$0")/../.." && pwd)/test/fixtures/narration
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
ff() { "$FF" -hide_banner -loglevel error -y "$@"; }
wav() { echo -map_metadata -1 -fflags +bitexact -flags:a +bitexact -c:a pcm_s16le -ar 24000 -ac 1; }

# speak <voice> <name> <text>: 0.5 s lead-in and 0.6 s tail of digital silence around the speech.
speak() {
  say -v "$1" -o "$TMP/$2.say.wav" --file-format=WAVE --data-format=LEI16@24000 "$3"
  ff -i "$TMP/$2.say.wav" -af "adelay=500:all=1,apad=pad_dur=0.6" $(wav) "$TMP/$2.wav"
}
speak Samantha laptop "Welcome back. [[slnc 700]] Today we will set up a new project, connect a repository, and publish the first deploy. [[slnc 600]] It takes about a minute."
speak Daniel noisy "This part matters most. [[slnc 700]] Every change you push builds a preview, so the whole team can review it before it goes live. [[slnc 500]] Nice and simple."
speak Karen usb "Let's look at the settings page. [[slnc 600]] Here you can add a custom domain, turn on analytics, and invite people to your team. [[slnc 500]] That's it."
speak Moira clip "And now the exciting part! [[slnc 600]] Watch the numbers climb as the traffic arrives, [[slnc 300]] faster and faster, right up to the launch."
speak Tessa sibilant "Sixty seconds is plenty. [[slnc 600]] She sells the system: instant rollbacks, serverless functions, and precise, simple settings."
speak Rishi punchq "First, open the dashboard and choose your site."
speak Rishi punchl "Then select deploys, and press the button to publish."

# Each noise bed is the length of its speech: anoisesrc with a fixed seed, mixed with amix normalize=0.
mix() { # mix <in> <out> <speech filter> <noise lavfi graph>
  ff -i "$TMP/$1.wav" -filter_complex "[0:a]$3[s];$4[n];[s][n]amix=inputs=2:duration=first:normalize=0,aformat=sample_fmts=s16" $(wav) "$OUT/$2.wav"
}
# Quiet room, laptop mic: low level (~-40 LUFS), band-limited 150 Hz-7 kHz, short room echo, faint hiss (gaps ~-79 dBFS).
mix laptop quiet-laptop "highpass=f=150,lowpass=f=7000,aecho=0.8:0.6:23|41:0.25|0.15,volume=-17dB" \
  "anoisesrc=r=24000:c=pink:a=0.0006:s=11"
# Noisy room: speech ~-24 LUFS over pink + brown noise (gaps ~-53 dBFS) and a fan hum at 120 Hz with a 240 Hz harmonic.
mix noisy noisy-room "volume=-4dB" \
  "anoisesrc=r=24000:c=pink:a=0.004:s=21[p];anoisesrc=r=24000:c=brown:a=0.01:s=22[b];sine=f=120:r=24000,volume=0.006[h1];sine=f=240:r=24000,volume=0.002[h2];[p][b][h1][h2]amix=inputs=4:normalize=0"
# USB mic: clean and hot (about -15 LUFS, peaks near -1.5 dBFS), gaps ~-75 dBFS.
mix usb usb-hot "volume=2dB" "anoisesrc=r=24000:c=white:a=0.00008:s=31"
# Near clipping: +14 dB into a tanh soft clipper, then -0.1 dB (sample peaks at the tanh ceiling, true peak +2 dBTP).
mix clip near-clip "volume=14dB,asoftclip=type=tanh,volume=-0.1dB" "anoisesrc=r=24000:c=pink:a=0.0004:s=41"
# Sibilant headset: +8 dB shelf at 6 kHz (exaggerated esses), mid level, light hiss.
mix sibilant sibilant-headset "treble=g=8:f=6000,volume=-6dB" "anoisesrc=r=24000:c=white:a=0.0006:s=51"
# Silence-only take: 3 s of room tone (pink noise, ~-76 dBFS RMS), no speech.
ff -f lavfi -i "anoisesrc=r=24000:c=pink:a=0.0008:s=61:d=3" -af aformat=sample_fmts=s16 $(wav) "$OUT/silence-only.wav"
# Punch pair, same voice and room: a quiet take (~-38 LUFS) punched into a loud one (~-19 LUFS).
mix punchq punch-quiet "volume=-20dB" "anoisesrc=r=24000:c=pink:a=0.0008:s=71"
mix punchl punch-loud "volume=0dB" "anoisesrc=r=24000:c=pink:a=0.0008:s=72"
ls -l "$OUT"/*.wav
