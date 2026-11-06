// The player's bundle (cli-and-sdk plan §7 Delivery): the same esbuild settings for the package's dist/index.js and
// the /player.js every deployment serves, so a fork's embeds never depend on npm or a CDN and the bytes match.
import { join } from 'node:path'
import type { BuildOptions } from 'esbuild'

/** esbuild settings for a public package's entry points (scripts/build-packages.ts). */
export function packageBuildOptions(root: string, node: boolean): BuildOptions {
  return {
    entryPoints: [join(root, 'src/index.ts'), ...(node ? [join(root, 'src/bin.ts')] : [])],
    bundle: true,
    format: 'esm',
    platform: node ? 'node' : 'neutral',
    target: node ? 'node22' : 'es2022',
    // css-tree (the app's scope checks, which local mode runs too) loads its data with createRequire at run time,
    // which a bundle can't follow; its prebuilt ESM bundle has the data inlined.
    alias: { 'css-tree': 'css-tree/dist/csstree.esm' },
    logLevel: 'warning',
  }
}

/** The settings that write the player to one file, e.g. ui/dist/player.js. */
export function playerBuildOptions(repoRoot: string, outfile: string): BuildOptions {
  return { ...packageBuildOptions(join(repoRoot, 'packages/player'), false), outfile }
}
