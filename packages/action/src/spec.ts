// The action's inputs and outputs (docs/plans/2026-11-04-github-action.md §3.4). action.yml lists the same names and
// defaults; test/spec.test.ts compares them so they can't drift.

export interface InputSpec {
  name: string
  /** The default action.yml declares, or undefined for none (validated in code instead). */
  default?: string
  description: string
}

export const INPUTS = [
  {
    name: 'url',
    description:
      'The Video Agent site, e.g. https://acme-video.netlify.app. Store it as an org-level variable, not a secret (a secret would mask every link the action prints).',
  },
  { name: 'api-key', description: 'An nva_ API key from a secret, for a CI account with the Creator role.' },
  {
    name: 'target',
    description:
      'pr/<number> or release/<tag>: what the video is for, when the event does not say (workflow_dispatch, the step after a release tool).',
  },
  {
    name: 'prompt',
    description:
      'Extra instructions added to the brief. With no PR or release target (workflow_dispatch), the whole brief.',
  },
  { name: 'base-video', description: 'A video id (vid_…) to remix instead of creating from scratch.' },
  { name: 'aspect', default: '16:9', description: '16:9, 9:16, 1:1 or 4:5.' },
  { name: 'duration', description: 'Target length in seconds. Default: 30 for a PR, 45 for a release.' },
  { name: 'look', description: 'A look id, sent only when the server lists looks in its features.' },
  {
    name: 'label',
    default: 'video',
    description:
      'The PR label that asks for a video, and that new commits and commands require. Empty: no label needed.',
  },
  {
    name: 'on-push',
    default: 'ignore',
    description: 'ignore, or revise: update the video when the PR gets new commits.',
  },
  { name: 'max-versions', default: '3', description: 'Versions the action may make per PR or release.' },
  {
    name: 'max-runs-per-day',
    default: '10',
    description:
      "Runs (new videos, revisions, remixes, retries) this account may start in 24 hours, counted from the server's video list.",
  },
  {
    name: 'max-credits-per-month',
    description:
      "Optional. Start nothing when this month's run credits (GET /api/v1/me/usage) are at or above it.",
  },
  {
    name: 'screenshots',
    default: 'body',
    description:
      'none, body (images in the PR description), or a glob of workspace files (video-shots/*.png).',
  },
  {
    name: 'publish',
    default: 'false',
    description: 'Publish the ready version so the comment shows the GIF and a public link.',
  },
  {
    name: 'private',
    default: 'false',
    description: 'Make the video private in the app. Refused together with publish.',
  },
  {
    name: 'timeout-minutes',
    default: '30',
    description: 'How long to wait for the video. 0: start it and return at once.',
  },
  {
    name: 'release-asset',
    default: 'false',
    description:
      'Attach video.mp4 and captions.vtt to the release. On a public repo this needs publish: true.',
  },
  {
    name: 'trust',
    default: 'members',
    description:
      'members: people must have write access to the repo, no fork PRs. forks: also commands on fork PRs, from members.',
  },
  {
    name: 'dry-run',
    default: 'false',
    description: 'Build and print the brief and the calls it would make; spend and change nothing.',
  },
  {
    name: 'github-token',
    default: '${{ github.token }}',
    description: 'For comments, reactions and releases.',
  },
] as const satisfies readonly InputSpec[]

export type InputName = (typeof INPUTS)[number]['name']

export const OUTPUTS = [
  { name: 'video-id', description: 'The video (vid_…).' },
  { name: 'version', description: 'The version this run made or followed.' },
  {
    name: 'status',
    description:
      'ready, failed, timed_out, cancelled, running (still making it), skipped, refused, limited, dry_run or none.',
  },
  { name: 'web-url', description: 'The video in the app (needs a sign-in).' },
  { name: 'share-url', description: 'The public share page, when published.' },
  { name: 'mp4-url', description: 'The public MP4, when published.' },
  { name: 'gif-url', description: 'The public preview GIF, when published.' },
  { name: 'poster-url', description: 'The public poster, when published.' },
  { name: 'duration-sec', description: 'The video length in seconds, when ready.' },
  { name: 'credits', description: 'Credits the version cost (at least this much for unfinished attempts).' },
  { name: 'comment-id', description: 'The sticky PR comment.' },
  { name: 'created', description: 'true when this run made a new video or version.' },
  { name: 'prompt', description: 'The brief that was sent.' },
] as const

export type OutputName = (typeof OUTPUTS)[number]['name']

/** Sent in the SDK's User-Agent (video-agent-action/<version>) so the deployment's logs show the action. */
export const ACTION_VERSION = '1.0.0'

/** Every value outputs.status takes, so later steps can branch on it (the README's table is checked against this). */
export const OUTPUT_STATUSES = [
  'ready',
  'failed',
  'cancelled',
  'timed_out',
  'still-making',
  'queued',
  'skipped',
  'refused',
  'dry-run',
  'none',
  'error',
] as const
