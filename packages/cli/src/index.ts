// netlify-video-agent: the video-agent command (docs/plans/2026-11-04-cli-and-sdk.md §6). An empty package until
// phase 3 adds the catalog and the commands.

/** This package's name, as published. */
export const PACKAGE_NAME = 'netlify-video-agent'

export interface Io {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** Runs the command line; resolves to the exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  if (argv[0] === '--version') {
    io.stdout('0.0.0\n')
    return 0
  }
  io.stderr('video-agent has no commands yet.\n')
  return 2
}
