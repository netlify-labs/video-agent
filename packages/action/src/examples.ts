// The example workflows (github-action plan §8), written once: /docs/github shows them and test/docs.test.ts checks
// that packages/action/README.md carries the same ones. Each pins the action to a full commit SHA with the tag in a
// comment; PIN is the commit action-v1.0.0 tags; move it with each release.

/** The commit the examples pin, and the tag it carries. */
export const PIN = { sha: '89d737ce734c308660ec7c55aa9f8b8c6d1bef3e', tag: 'action-v1.0.0' }

export const USES = `netlify-labs/video-agent/packages/action@${PIN.sha} # ${PIN.tag}`

export interface Example {
  id: string
  title: string
  /** One sentence on when to use it. */
  note: string
  yaml: string
}

export const EXAMPLES: readonly Example[] = [
  {
    id: 'pr',
    title: 'A video for labelled PRs',
    note: 'Add the video label to a pull request; new commits revise the video when on-push is revise.',
    yaml: `# .github/workflows/pr-video.yml
name: PR video
on:
  pull_request:
    types: [labeled, synchronize]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: pr-video-\${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  video:
    if: contains(github.event.pull_request.labels.*.name, 'video')
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: ${USES}
        with:
          url: \${{ vars.VIDEO_AGENT_URL }} # an org-level variable
          api-key: \${{ secrets.VIDEO_AGENT_KEY }}
          prompt: For people who use Acme.
          on-push: ignore # revise: update the video on new commits
`,
  },
  {
    id: 'commands',
    title: '/video commands',
    note: 'A separate workflow with no concurrency group, so a command is never dropped behind a running video.',
    yaml: `# .github/workflows/pr-video-commands.yml
name: PR video commands
on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  command:
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '/video')
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: ${USES}
        with:
          url: \${{ vars.VIDEO_AGENT_URL }} # an org-level variable
          api-key: \${{ secrets.VIDEO_AGENT_KEY }}
`,
  },
  {
    id: 'release',
    title: 'A changelog video on every release',
    note: 'For releases published by a person, or by a token that isn’t GITHUB_TOKEN.',
    yaml: `# .github/workflows/release-video.yml
name: Release video
on:
  release:
    types: [published]

permissions:
  contents: write

jobs:
  video:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: ${USES}
        id: video
        with:
          url: \${{ vars.VIDEO_AGENT_URL }} # an org-level variable
          api-key: \${{ secrets.VIDEO_AGENT_KEY }}
          publish: true
          release-asset: true
      - run: echo "Watch it at \${{ steps.video.outputs.share-url }}"
`,
  },
  {
    id: 'release-please',
    title: 'After release-please',
    note: 'A release made with GITHUB_TOKEN never fires release: published, so run the action as the next step.',
    yaml: `# .github/workflows/release-please.yml
name: Release
on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: googleapis/release-please-action@v4
        id: rp
      - if: steps.rp.outputs.release_created
        uses: ${USES}
        with:
          url: \${{ vars.VIDEO_AGENT_URL }} # an org-level variable
          api-key: \${{ secrets.VIDEO_AGENT_KEY }}
          target: release/\${{ steps.rp.outputs.tag_name }}
`,
  },
  {
    id: 'screenshots',
    title: 'Screenshots of a deploy preview',
    note: 'Check out your own base branch (never a fork’s head), take screenshots with Playwright, and pass them in.',
    yaml: `# .github/workflows/pr-video.yml, with screenshots
name: PR video
on:
  pull_request:
    types: [labeled]

permissions:
  contents: read
  pull-requests: write

jobs:
  video:
    if: contains(github.event.pull_request.labels.*.name, 'video') && !github.event.pull_request.head.repo.fork
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v4 # this repo's own trusted code: the base branch, never a fork's head
      - run: npx -y playwright@1 install --with-deps chromium
      - run: node .github/scripts/shoot.mjs "$PREVIEW_URL" video-shots/
        env:
          PREVIEW_URL: https://deploy-preview-\${{ github.event.pull_request.number }}--acme.netlify.app
      - uses: ${USES}
        with:
          url: \${{ vars.VIDEO_AGENT_URL }} # an org-level variable
          api-key: \${{ secrets.VIDEO_AGENT_KEY }}
          screenshots: video-shots/*.png
`,
  },
]

/** .github/scripts/shoot.mjs for the screenshots example. */
export const SHOOT_SCRIPT = `// node .github/scripts/shoot.mjs <url> <dir>: full-page screenshots of a few paths, for the video.
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const [base, dir] = process.argv.slice(2)
const paths = ['/', '/pricing'] // the pages your change touches
await mkdir(dir, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
for (const [i, p] of paths.entries()) {
  // Deploy previews take a minute to build: retry until the page answers.
  for (let tries = 0; tries < 30; tries++) {
    const res = await page.goto(new URL(p, base).href).catch(() => null)
    if (res?.ok()) break
    await page.waitForTimeout(10_000)
  }
  await page.screenshot({ path: \`\${dir}/\${String(i + 1).padStart(2, '0')}.png\` })
}
await browser.close()
`

/** What each server feature changes in the action, for the page's "This deployment" list. */
export const FEATURE_NOTES: readonly { feature: string; label: string; without: string }[] = [
  {
    feature: 'context',
    label: 'The PR or release text travels as context beside a short prompt',
    without: 'the text goes in the prompt (up to 4,000 characters)',
  },
  {
    feature: 'external_ref',
    label: 'Videos carry their PR or release, and are found by it',
    without: 'found by the reference line at the end of the prompt',
  },
  {
    feature: 'scoped_revision',
    label: '/video redo <scene> remakes one scene',
    without: '/video redo answers 😕',
  },
  { feature: 'remix', label: 'base-video remixes a house video', without: 'base-video is refused' },
  { feature: 'looks', label: 'The look input picks a look', without: 'look is ignored with a warning' },
]
