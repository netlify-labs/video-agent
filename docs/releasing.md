# Releasing the SDK, CLI and player

The public packages are `netlify-video-agent-sdk`, `netlify-video-agent` (the CLI) and `netlify-video-agent-player`,
built from `packages/*` by `npm run build:packages`. `packages/action` is private and released by the GitHub Action's
own script. `.github/workflows/release.yml` (run by hand) runs `scripts/release-packages.ts`.

## Internal tarballs (until the repo is public)

```sh
gh workflow run release.yml -f mode=internal
```

The run uploads `packages-<sha>`: one `.tgz` per package plus `manifest.json` (versions, file counts, sizes,
sha256s). Testers install by path, for example `npm install -g ./netlify-video-agent-0.1.0.tgz`. The CLI's tarball
bundles the SDK and needs only `css-tree` from npm. Locally, `npx tsx scripts/release-packages.ts pack --out <dir>`
does the same. Every tarball may hold only `dist/`, `package.json` and the package's README, LICENSE and CHANGELOG;
anything else fails the pack.

## npmjs (after the repo is public)

Before the first publish:

1. The names exist on npmjs (the 0.0.0 placeholders, C4).
2. Each package has a trusted publisher on npmjs.com: this repository, workflow `release.yml`, and the allowed
   actions it uses (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`).

Then, for each release:

1. Bump `version` in each changed `packages/*/package.json` and add a `CHANGELOG.md` entry. Stay on 0.x until the
   public launch. After 1.0, a breaking API change (the `api-breaking` job) needs a major SDK version.
2. Merge to main, then run `gh workflow run release.yml -f mode=publish -f confirm=publish`.

It publishes, with provenance, every package whose version isn't on npmjs yet, and skips the rest.

Changesets isn't used: it finds packages through npm workspaces, which this repo doesn't use because they broke Agent
Runner deploys.
