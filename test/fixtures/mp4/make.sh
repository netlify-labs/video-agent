#!/bin/sh
# Regenerates the MP4 fixtures for test/mp4.test.ts (screen-recording plan §4.2): small 320x180 clips with known
# keyframe gaps, frame rates and layouts. Needs ffmpeg with libx264. Expected values live in expected.json.
#   sh test/fixtures/mp4/make.sh
set -eu
cd "$(dirname "$0")"
src="testsrc2=s=320x180:r=30"
x264="-c:v libx264 -preset ultrafast -crf 45 -pix_fmt yuv420p -sc_threshold 0"
q="-loglevel error -y"

# 1 s GOP, fast start: the recording norm.
ffmpeg $q -f lavfi -i "$src:d=3" $x264 -g 30 -keyint_min 30 -movflags +faststart gop30.mp4
# One keyframe in 3 s: the gap is the whole clip.
ffmpeg $q -f lavfi -i "$src:d=3" $x264 -g 300 -keyint_min 300 -movflags +faststart gop300.mp4
# All intra: ffmpeg writes no stss, so every sample is a sync sample.
ffmpeg $q -f lavfi -i "$src:d=1" $x264 -g 1 -movflags +faststart intra.mp4
# Fragmented (empty moov, moof per keyframe).
ffmpeg $q -f lavfi -i "$src:d=2" $x264 -g 30 -movflags frag_keyframe+empty_moov fragmented.mp4
# moov after mdat.
ffmpeg $q -f lavfi -i "$src:d=2" $x264 -g 30 slowstart.mp4
# Variable frame rate: 1 s at 30 fps then 1 s at 15 fps, joined without re-encoding.
ffmpeg $q -f lavfi -i "$src:d=1" $x264 -g 30 -video_track_timescale 15360 vfr-a.mp4
ffmpeg $q -f lavfi -i "testsrc2=s=320x180:r=15:d=1" $x264 -g 15 -video_track_timescale 15360 vfr-b.mp4
printf "file 'vfr-a.mp4'\nfile 'vfr-b.mp4'\n" > vfr.txt
ffmpeg $q -f concat -safe 0 -i vfr.txt -c copy -movflags +faststart vfr.mp4
rm -f vfr-a.mp4 vfr-b.mp4 vfr.txt
# Audio only (an M4A).
ffmpeg $q -f lavfi -i "sine=f=440:d=1" -c:a aac -b:a 64k -movflags +faststart audio.m4a
