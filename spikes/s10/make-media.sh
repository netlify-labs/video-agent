#!/usr/bin/env bash
# Spike S10: generates the test media into spikes/s10/media/ (git-ignored; nothing here is committed).
#
#   test-<D>s.mp4  H.264 30 fps, 480x270, muted: black with a full-frame WHITE FLASH for 3 frames starting at every
#                  flash time, a 15-bit binary frame counter (white squares, bit 0 left), bit 14 right.
#   stem-<D>s.wav  48 kHz mono PCM16: a quiet "music" bed (220/330 Hz, slow tremolo) plus 2 kHz BEEPS, 50 ms,
#                  starting exactly (to the sample) at the flash times. This is what the monitor plays.
#   fake-mic.wav   48 kHz mono PCM16, 30 s, beeps every 2.000 s from 1.000 s (Chromium loops it as the fake mic).
#   manifest.json  durations, fps and flash times.
#
# Flash times: 1 s, then every 4 s, while t <= D - 1 (30 s: 1, 5, ..., 29, i.e. 8 flashes; 600 s: 150 flashes).
# Usage: spikes/s10/make-media.sh [durations...]   (default: 30 600)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/media"
mkdir -p "$out"
durs=("$@")
[ ${#durs[@]} -eq 0 ] && durs=(30 600)

counter=""
for k in $(seq 0 14); do
  counter+="drawbox=x=$((12 + k * 20)):y=12:w=16:h=16:c=white:t=fill:enable='mod(floor(n/pow(2\,$k))\,2)',"
done

for d in "${durs[@]}"; do
  mp4="$out/test-${d}s.mp4"
  wav="$out/stem-${d}s.wav"
  if [ ! -s "$mp4" ]; then
    ffmpeg -hide_banner -loglevel error -y \
      -f lavfi -i "color=c=black:s=480x270:r=30:d=$d" \
      -vf "${counter}drawbox=x=0:y=0:w=iw:h=ih:c=white:t=fill:enable='gte(n\,30)*lt(mod(n-30\,120)\,3)'" \
      -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 30 -movflags +faststart -an "$mp4"
  fi
  if [ ! -s "$wav" ]; then
    ffmpeg -hide_banner -loglevel error -y \
      -f lavfi -i "aevalsrc=exprs='0.06*sin(2*PI*220*t)+0.04*sin(2*PI*330*t)*(0.6+0.4*sin(2*PI*0.25*t))+0.5*sin(2*PI*2000*(t-1))*gte(t\,1)*lt(mod(t-1\,4)\,0.05)':s=48000:d=$d" \
      -c:a pcm_s16le "$wav"
  fi
done

if [ ! -s "$out/fake-mic.wav" ]; then
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "aevalsrc=exprs='0.5*sin(2*PI*2000*(t-1))*gte(t\,1)*lt(mod(t-1\,2)\,0.05)+0.001*sin(2*PI*97*t)':s=48000:d=30" \
    -c:a pcm_s16le "$out/fake-mic.wav"
fi

OUT="$out" node -e '
const fs = require("node:fs")
const media = {}
for (const f of fs.readdirSync(process.env.OUT)) {
  const m = /^test-(\d+)s\.mp4$/.exec(f)
  if (!m) continue
  const d = Number(m[1])
  const flashes = []
  for (let t = 1; t <= d - 1; t += 4) flashes.push(t)
  media[d] = { video: f, stem: `stem-${d}s.wav`, duration: d, fps: 30, flashFrames: 3, beepMs: 50, flashes }
}
const fake = { file: "fake-mic.wav", duration: 30, firstBeep: 1, period: 2, beepMs: 50 }
fs.writeFileSync(process.env.OUT + "/manifest.json", JSON.stringify({ media, fake }, null, 2))
'
ls -la "$out"
