# Live tests against a deployed site

## Voice-over live gates

Two scripts check recorded voice-over against a deployed site (plan
[§9–§10](../../docs/plans/2026-11-02-record-your-own-voiceover.md)). Run either one with `--dry` first: it checks the env
(and, for the second, ffmpeg and the fixtures), prints the steps and the projected credits, and makes no requests.

```sh
# Phase 1, take privacy + GC (no credits). A owns the test video; B is a Creator (not an admin); R is a Reviewer.
VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… VIDEO_AGENT_KEY_B=nva_… VIDEO_AGENT_KEY_R=nva_… \
  [VIDEO_ID=vid_…] npx tsx scripts/e2e/narration-privacy.ts

# Phase 2, upload -> keep-visuals render (2 renders, about 34 credits each; MAX_CREDITS defaults to 250).
# Needs ffmpeg/ffprobe. Add VIDEO_PUBLISH_OK=1 for the public-captions checks, VIDEO_AGENT_KEY_R for the Reviewer
# checks, and LONG=1 LONG_VIDEO_IDS=vid_…,vid_… for the 4- and 10-minute bus runs (4 more renders).
VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [VIDEO_ID=vid_…] npx tsx scripts/e2e/narration.ts
npx tsx scripts/e2e/narration.ts --selftest   # its audio/frame/caption analysis on a local stand-in render
```

The phase-1 script stops before uploading anything if A has other unused recordings, because "Delete unused
recordings" would delete them too. Set `ALLOW_DELETE_UNUSED=1` to let it continue anyway. Both scripts clean up
what they made, even when a check fails. The header comment of each script lists every variable it reads and
every check it makes.

## Remix live gate

`scripts/e2e/remix.ts` checks remixing against a deployed site (remix spec
[§7](../../docs/plans/2026-11-03-remix.md)): a targeted remix keeps the first frame, a new-topic remix changes the
captions, a narrated source loses its narration, and replaying a request with the same idempotency key returns the
same video. It spends two or three runs and stops starting new ones once `CREDIT_CEILING` (default 600) is reached.
Run it with `--dry` first.

```sh
VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… SOURCE_ID=vid_… [NARRATED_ID=vid_…] \
  npx tsx scripts/e2e/remix.ts [--keep]
```

## Redo-a-scene live gate

`scripts/e2e/regen-beat.ts` checks scoped revisions against a deployed site (regenerate-beat spec
[§7](../../docs/plans/2026-11-04-regenerate-beat.md)). It redoes one scene of a ready contract-v1 video, then compares the
frozen scenes' frames and captions with the parent's and reads the stored composition back from Blobs. It stops
starting runs once `CREDIT_CEILING` (default 700) is reached. `--dry` lists the steps and the projected credits
without sending anything, and `--selftest` runs its frame and caption checks on local fixtures.

```sh
VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… NETLIFY_SITE_ID=… SOURCE_ID=vid_… \
  npx tsx scripts/e2e/regen-beat.ts [--dry] [--steps 1,2]
```
