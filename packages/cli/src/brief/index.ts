// The brief builder: every request the GitHub Action (and `video-agent brief …`) sends is written here, so CI systems
// write the same briefs. Pure functions over plain inputs: the caller
// fetches from GitHub and passes the data in.
export {
  dedupeCommits,
  excludedBecause,
  CONTEXT_BUDGET,
  GITHUB_BUDGET,
  MAX_PROMPT,
  MAX_TITLE,
  trimAtParagraph,
  trimLine,
} from './budget.js'
export { prBrief, prTitle, screenshotCaption, PR_DURATION_SEC, type PrInput } from './pr.js'
export {
  appendRef,
  describeTarget,
  endsWithRef,
  refFor,
  refLine,
  REF_LINE_PREFIX,
  REF_MAX,
  type Target,
} from './reference.js'
export {
  changelogBrief,
  releaseBrief,
  releaseBullets,
  releaseTitle,
  RELEASE_DURATION_SEC,
  type ChangelogInput,
  type ReleaseInput,
} from './release.js'
export {
  dispatchBrief,
  remixBrief,
  reviseBrief,
  type BriefContext,
  type RemixInput,
  type ReviseInput,
} from './revise.js'
export { describeRemoved, looksRandom, scrub, secretsRemoved, type Removed, type ScrubKind } from './scrub.js'
export type { Brief, ContextField } from './types.js'
