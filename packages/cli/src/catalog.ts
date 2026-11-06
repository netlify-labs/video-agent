// The command catalog (cli-and-sdk plan §6.1): one list that the router, --help, `help --json`, the /docs/cli page and
// the skill's references/cli.md all come from, like src/mcp-catalog.ts for the MCP tools. A command is runnable once
// its bead lands (`ready`); until then it's listed nowhere and answers "not built yet". People see "scene", "Look",
// "Restyle"; flags follow those words (--scene, --look, --engine); the API keeps beat, scope, look and engine.

/** The server's `features` strings a command can need (src/domain/features.ts; a test keeps them in step). */
export type FeatureName =
  | 'remix'
  | 'narration'
  | 'planning'
  | 'cli_login'
  | 'looks'
  | 'engines'
  | 'scoped_revision'
  | 'screen_recording'
  | 'context'
  | 'external_ref'
  | 'destinations'
  | 'youtube'

export type ArgType = 'string' | 'video' | 'file'

export interface ArgSpec {
  name: string
  type: ArgType
  required?: boolean
  /** Takes the rest of the positionals. */
  variadic?: boolean
  description: string
}

export interface FlagSpec {
  type: 'string' | 'boolean' | 'number'
  description: string
  short?: string
  multiple?: boolean
  default?: string | boolean | number
}

export interface CommandSpec {
  /** Words, space-separated for subcommands: "media upload". */
  name: string
  summary: string
  args: ArgSpec[]
  flags: Record<string, FlagSpec>
  examples: string[]
  /** SDK methods it calls (docs; and the coverage test checks they exist). */
  sdk: string[]
  /** Hidden unless the server lists this feature; invoking it anyway exits 9. */
  feature?: FeatureName
  /** Works only against a deployed Video Agent (not in local mode). */
  needsHostedApp?: boolean
  /** Local mode: never needs a server, always listed. */
  local?: boolean
  /** Implemented and listed. */
  ready: boolean
}

/** Flags every command takes. */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: 'boolean', description: 'Print one JSON object on stdout and nothing else there.' },
  verbose: {
    type: 'boolean',
    description: 'Log each request and step as JSON lines on stderr (or VIDEO_AGENT_DEBUG=1).',
  },
  url: { type: 'string', description: 'The deployment (else VIDEO_AGENT_URL, else the config file).' },
  key: {
    type: 'string',
    description: "An API key, nva_… (else VIDEO_AGENT_KEY, else the config file). '-' reads stdin.",
  },
  help: { type: 'boolean', short: 'h', description: 'Show help for the command.' },
}

const video: ArgSpec = {
  name: 'video',
  type: 'video',
  required: true,
  description: 'A video id (vid_…), its web address or a share link.',
}
const versionFlag: FlagSpec = { type: 'number', description: 'The version (default: the latest).' }
const waitFlags: Record<string, FlagSpec> = {
  wait: { type: 'boolean', description: 'Follow the run until the video is ready.' },
  timeout: {
    type: 'string',
    description: 'With --wait: give up after this long: seconds, or 30m, 2h (exit 6).',
  },
}

export const COMMANDS: CommandSpec[] = [
  {
    name: 'help',
    summary: 'List the commands, or explain one.',
    args: [
      { name: 'command', type: 'string', variadic: true, description: 'A command, e.g. "media upload".' },
    ],
    flags: {},
    examples: ['video-agent help', 'video-agent help create', 'video-agent help --json'],
    sdk: ['config.get'],
    local: true,
    ready: true,
  },
  {
    name: 'version',
    summary: "Print the CLI's version, and the server's when one is configured.",
    args: [],
    flags: {},
    examples: ['video-agent version', 'video-agent version --json'],
    sdk: ['config.get'],
    local: true,
    ready: true,
  },
  {
    name: 'login',
    summary: 'Get an API key by approving this CLI in the browser, or save a key you paste.',
    args: [],
    flags: {
      'no-browser': { type: 'boolean', description: 'Print the address and code only (SSH, containers).' },
      'no-save': {
        type: 'boolean',
        description: 'With --key -: check the key, keep it out of the config file.',
      },
    },
    examples: [
      'video-agent login --url https://acme-video.netlify.app',
      'printf %s "$KEY" | video-agent login --key - --no-save',
    ],
    // No `feature`: login checks cli_login itself, so a server without it gets the --key hint, not "unsupported".
    sdk: ['me.get', 'config.get', 'cliLogins.create', 'cliLogins.claim'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'logout',
    summary: 'Forget the saved key.',
    args: [],
    flags: { revoke: { type: 'boolean', description: 'Revoke it on the server too.' } },
    examples: ['video-agent logout --revoke'],
    sdk: ['keys.revoke'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'whoami',
    summary: 'Show who the key acts as, and the server.',
    args: [],
    flags: {},
    examples: ['video-agent whoami'],
    sdk: ['me.get', 'config.get'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'create',
    summary: 'Make a video from a prompt.',
    args: [{ name: 'prompt', type: 'string', description: 'What the video is about (or --prompt-file).' }],
    flags: {
      aspect: { type: 'string', description: '16:9, 9:16, 1:1 or 4:5.' },
      title: { type: 'string', description: 'The video title.' },
      look: { type: 'string', description: 'A Look id (video-agent looks), or none.' },
      engine: { type: 'string', description: 'A render engine id.' },
      plan: {
        type: 'boolean',
        description: 'Ask the planning questions and stop (needs planning on the server).',
      },
      'plan-id': {
        type: 'string',
        description: 'With --answers: answer a plan and make the video from its brief.',
      },
      answers: { type: 'string', description: "The answers: a JSON file, or '-' for stdin." },
      duration: { type: 'number', description: 'Target length in seconds.' },
      sound: { type: 'string', description: 'silent, music or music_sfx.' },
      voice: { type: 'string', description: 'A voice-over in this voice (e.g. af_heart), or off.' },
      media: {
        type: 'string',
        multiple: true,
        description:
          'A media id, or a file to upload first (file:"caption" sets its caption). Repeatable, up to 12.',
      },
      'webhook-url': { type: 'string', description: "Also send this video's webhook events here." },
      'idempotency-key': { type: 'string', description: 'Retrying with the same key never makes two.' },
      'prompt-file': { type: 'string', description: "Read the prompt from a file, or '-' for stdin." },
      out: {
        type: 'string',
        description: 'Follow it, then download the video, poster and captions into this folder.',
      },
      ...waitFlags,
    },
    examples: [
      'video-agent create "A 20-second launch video for webhooks" --aspect 16:9 --wait --out webhooks.mp4',
    ],
    sdk: ['videos.create', 'videos.wait', 'media.upload', 'files.download'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'revise',
    summary: 'Make the next version of a video.',
    args: [video, { name: 'change', type: 'string', required: true, description: 'What to change.' }],
    flags: {
      'from-version': versionFlag,
      comments: { type: 'string', description: 'Comment ids to address, comma-separated.' },
      scene: {
        type: 'string',
        multiple: true,
        description: 'Only redo these scenes (id or label; repeatable).',
      },
      look: { type: 'string', description: 'Restyle with this Look, or none for no look.' },
      duration: { type: 'number', description: 'Target length in seconds.' },
      sound: { type: 'string', description: 'silent, music or music_sfx.' },
      voice: { type: 'string', description: 'A voice-over in this voice (e.g. af_heart), or off.' },
      media: {
        type: 'string',
        multiple: true,
        description:
          'A media id, or a file to upload first (file:"caption" sets its caption). Repeatable, up to 12.',
      },
      'webhook-url': { type: 'string', description: "Also send this video's webhook events here." },
      'idempotency-key': { type: 'string', description: 'Retrying with the same key never makes two.' },
      'prompt-file': { type: 'string', description: "Read the prompt from a file, or '-' for stdin." },
      out: {
        type: 'string',
        description: 'Follow it, then download the video, poster and captions into this folder.',
      },
      ...waitFlags,
    },
    examples: ['video-agent revise vid_01… "Make the end card orange" --wait'],
    sdk: ['videos.revise', 'videos.wait'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'redo',
    summary: 'Redo one or more scenes only.',
    args: [video, { name: 'change', type: 'string', required: true, description: 'What to change.' }],
    flags: {
      scene: { type: 'string', multiple: true, description: 'A scene, by id or label (repeatable).' },
      'from-version': {
        type: 'number',
        description: 'The version the scenes are from (default: the latest ready).',
      },
      'idempotency-key': { type: 'string', description: 'Retrying with the same key never makes two.' },
      ...waitFlags,
    },
    examples: ['video-agent redo vid_01… --scene intro "Shorter title"'],
    sdk: ['videos.get', 'versions.beats', 'videos.redoScenes', 'videos.wait'],
    feature: 'scoped_revision',
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'scenes',
    summary: "List a version's scenes.",
    args: [video],
    flags: { version: versionFlag },
    examples: ['video-agent scenes vid_01…'],
    sdk: ['videos.get', 'versions.beats'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'remix',
    summary: 'Make a new video from another one.',
    args: [video, { name: 'change', type: 'string', required: true, description: 'What the remix changes.' }],
    flags: {
      'from-version': versionFlag,
      aspect: { type: 'string', description: "16:9, 9:16, 1:1 or 4:5 (default: the source's)." },
      language: { type: 'string', description: "The language (default: the source's)." },
      look: { type: 'string', description: "A Look id, or none (default: the source's)." },
      duration: { type: 'number', description: 'Target length in seconds.' },
      sound: { type: 'string', description: 'silent, music or music_sfx.' },
      voice: { type: 'string', description: 'A voice-over in this voice (e.g. af_heart), or off.' },
      media: {
        type: 'string',
        multiple: true,
        description:
          'A media id, or a file to upload first (file:"caption" sets its caption). Repeatable, up to 12.',
      },
      'webhook-url': { type: 'string', description: "Also send this video's webhook events here." },
      'idempotency-key': { type: 'string', description: 'Retrying with the same key never makes two.' },
      'prompt-file': { type: 'string', description: "Read the prompt from a file, or '-' for stdin." },
      out: {
        type: 'string',
        description: 'Follow it, then download the video, poster and captions into this folder.',
      },
      ...waitFlags,
    },
    examples: ['video-agent remix vid_01… "Same format, about edge functions"'],
    sdk: ['videos.remix'],
    feature: 'remix',
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'looks',
    summary: 'List the Looks.',
    args: [],
    flags: {},
    examples: ['video-agent looks', 'video-agent looks --json'],
    sdk: ['looks.list'],
    feature: 'looks',
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'restyle',
    summary: 'Restyle a video with another Look.',
    args: [video, { name: 'look', type: 'string', required: true, description: 'A Look id, or none.' }],
    flags: waitFlags,
    examples: ['video-agent restyle vid_01… kinetic --wait'],
    sdk: ['looks.list', 'videos.revise', 'videos.wait'],
    feature: 'looks',
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'get',
    summary: 'Show a video.',
    args: [video],
    flags: {},
    examples: ['video-agent get vid_01… --json'],
    sdk: ['videos.get', 'videos.resolve'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'list',
    summary: 'List videos.',
    args: [],
    flags: {
      mine: { type: 'boolean', description: 'Only yours.' },
      search: { type: 'string', description: 'Search titles and prompts.' },
      status: {
        type: 'string',
        description: 'queued, running, finishing, ready, failed, cancelled or timed_out.',
      },
      published: { type: 'boolean', description: 'Only published ones.' },
      favorite: { type: 'boolean', description: 'Only the ones you starred.' },
      limit: { type: 'number', description: 'How many per page.' },
      all: { type: 'boolean', description: 'Every page, not just the first.' },
    },
    examples: ['video-agent list --mine --json'],
    sdk: ['videos.list', 'videos.listAll'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'wait',
    summary: 'Follow a run until the video is ready.',
    args: [video],
    flags: {
      version: versionFlag,
      timeout: { type: 'string', description: 'Give up after this long: seconds, or 30m, 2h (exit 6).' },
    },
    examples: ['video-agent wait vid_01… --timeout 1800'],
    sdk: ['videos.wait'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'download',
    summary: "Download a version's files.",
    args: [video],
    flags: {
      version: versionFlag,
      file: {
        type: 'string',
        description: 'video, poster, gif, captions, narration or all.',
        default: 'video',
      },
      out: { type: 'string', description: 'A file, or a folder (with --file all, default <id>-v<n>).' },
    },
    examples: ['video-agent download vid_01… --out launch.mp4'],
    sdk: ['files.download'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'publish',
    summary: 'Publish a version: share link, MP4 link and embed snippet.',
    args: [video],
    flags: {
      version: versionFlag,
      transcript: { type: 'boolean', description: 'Offer the transcript on the share page.' },
    },
    examples: ['video-agent publish vid_01… --json'],
    sdk: ['versions.publish'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'unpublish',
    summary: 'Take a version offline.',
    args: [video],
    flags: { version: versionFlag },
    examples: ['video-agent unpublish vid_01…'],
    sdk: ['versions.unpublish'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'cancel',
    summary: 'Cancel a running version.',
    args: [video],
    flags: { version: versionFlag },
    examples: ['video-agent cancel vid_01…'],
    sdk: ['versions.cancel'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'retry',
    summary: 'Try a failed version again.',
    args: [video],
    flags: { version: versionFlag, ...waitFlags },
    examples: ['video-agent retry vid_01… --wait'],
    sdk: ['versions.retry'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'comments list',
    summary: "List a video's comments.",
    args: [video],
    flags: { version: versionFlag },
    examples: ['video-agent comments list vid_01…'],
    sdk: ['comments.list'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'comments add',
    summary: 'Comment on a version.',
    args: [video, { name: 'text', type: 'string', required: true, description: 'The comment.' }],
    flags: { version: versionFlag, at: { type: 'number', description: 'At this time, in seconds.' } },
    examples: ['video-agent comments add vid_01… "Logo too small" --at 12'],
    sdk: ['comments.add'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'verdict',
    summary: 'Approve a version or ask for changes.',
    args: [
      video,
      { name: 'verdict', type: 'string', required: true, description: 'approve, changes or clear.' },
    ],
    flags: { version: versionFlag, note: { type: 'string', description: 'A note with the verdict.' } },
    examples: ['video-agent verdict vid_01… approve'],
    sdk: ['versions.setVerdict'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'media upload',
    summary: 'Upload files to the media library; waits until each is ready.',
    args: [{ name: 'file', type: 'file', required: true, variadic: true, description: 'Files to upload.' }],
    flags: { caption: { type: 'string', description: 'What the file shows (the agent reads it).' } },
    examples: ['video-agent media upload ./checkout.png --caption "New checkout page"'],
    sdk: ['media.upload'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'media list',
    summary: 'List the media library.',
    args: [],
    flags: {
      kind: { type: 'string', description: 'image, svg, video, font, audio or pdf.' },
      search: { type: 'string', description: 'Search names and captions.' },
    },
    examples: ['video-agent media list --json'],
    sdk: ['media.list'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'media get',
    summary: 'Show a media item.',
    args: [{ name: 'id', type: 'string', required: true, description: 'A media id.' }],
    flags: {},
    examples: ['video-agent media get med_01…'],
    sdk: ['media.get'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'keys list',
    summary: 'List your API keys.',
    args: [],
    flags: {},
    examples: ['video-agent keys list'],
    sdk: ['keys.list'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'keys revoke',
    summary: 'Revoke an API key.',
    args: [{ name: 'id', type: 'string', required: true, description: 'A key id.' }],
    flags: {},
    examples: ['video-agent keys revoke key_01…'],
    sdk: ['keys.revoke'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'keys create',
    summary: 'Explains where API keys come from (the API keys page, or login).',
    args: [],
    flags: {},
    examples: ['video-agent keys create'],
    sdk: [],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'open',
    summary: "Open a video's page in the browser.",
    args: [video],
    flags: {},
    examples: ['video-agent open vid_01…'],
    sdk: ['videos.resolve'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'api',
    summary: 'Call any API route, like gh api.',
    args: [
      { name: 'method', type: 'string', required: true, description: 'GET, POST, PUT, PATCH or DELETE.' },
      { name: 'path', type: 'string', required: true, description: 'e.g. /api/v1/stats' },
    ],
    flags: { data: { type: 'string', description: 'A JSON body, or @file.' } },
    examples: ['video-agent api GET /api/v1/me/usage'],
    sdk: ['raw'],
    needsHostedApp: true,
    ready: true,
  },
  {
    name: 'doctor',
    summary: 'Check Node, the config, the server and (for local mode) the tools.',
    args: [],
    flags: {},
    examples: ['video-agent doctor --json'],
    sdk: ['config.get', 'me.get'],
    local: true,
    ready: true,
  },
  {
    name: 'brief pr',
    summary: "Print the GitHub Action's brief for a pull request (pipe it into create --prompt-file -).",
    args: [{ name: 'pr', type: 'string', required: true, description: 'The pull request URL.' }],
    flags: {
      prompt: { type: 'string', description: 'Your own words, added to the brief ("for sales engineers").' },
      context: {
        type: 'boolean',
        description: "Put the PR's text in a context block (servers that list context).",
      },
      untrusted: { type: 'boolean', description: "Use only the title and files, not the author's words." },
    },
    examples: [
      'video-agent brief pr https://github.com/acme/web/pull/123',
      'video-agent brief pr https://github.com/acme/web/pull/123 | video-agent create --prompt-file - --wait',
    ],
    sdk: [],
    local: true,
    ready: true,
  },
  {
    name: 'brief release',
    summary: 'Print a changelog brief for a release, from its notes on GitHub or a file.',
    args: [{ name: 'tag', type: 'string', required: true, description: 'The release tag.' }],
    flags: {
      repo: { type: 'string', description: 'owner/name (default: GITHUB_REPOSITORY).' },
      'notes-file': {
        type: 'string',
        description: 'Read the notes from a file (or - for stdin) instead of GitHub.',
      },
      prompt: { type: 'string', description: 'Your own words, added to the brief.' },
      url: { type: 'string', description: 'Where the video should end (the product or the release page).' },
      context: {
        type: 'boolean',
        description: 'Put the notes in a context block (servers that list context).',
      },
    },
    examples: [
      'video-agent brief release v2.4.0 --repo acme/web',
      'video-agent brief release "$CI_COMMIT_TAG" --repo acme/web --notes-file CHANGELOG.md',
    ],
    sdk: [],
    local: true,
    ready: true,
  },
  {
    name: 'brief changelog',
    summary: 'Print a changelog brief from the pull requests merged since a date.',
    args: [],
    flags: {
      since: { type: 'string', description: 'YYYY-MM-DD.' },
      repo: { type: 'string', description: 'owner/name (default: GITHUB_REPOSITORY).' },
      prompt: { type: 'string', description: 'Your own words, added to the brief.' },
      url: { type: 'string', description: 'Where the video should end.' },
    },
    examples: ['video-agent brief changelog --since 2026-11-01 --repo acme/web'],
    sdk: [],
    local: true,
    ready: true,
  },
  {
    name: 'local',
    summary: 'Make a video on this machine with your own coding agent, inside its sandbox.',
    args: [{ name: 'prompt', type: 'string', required: true, description: 'What the video is about.' }],
    flags: {
      agent: { type: 'string', description: 'The coding agent: claude (the one this version supports).' },
      aspect: { type: 'string', description: '16:9, 9:16, 1:1 or 4:5.', default: '16:9' },
      duration: { type: 'number', description: 'Target length in seconds.' },
      sound: { type: 'string', description: 'silent, music or music_sfx.' },
      voice: { type: 'boolean', description: 'Add a spoken voice-over (needs Python 3.10 to 3.13).' },
      media: {
        type: 'string',
        multiple: true,
        description: 'A file to put in the video (file:"caption" sets its caption). Repeatable, up to 12.',
      },
      context: { type: 'string', description: 'Your brand folder (default ./context, else a neutral one).' },
      look: {
        type: 'string',
        description:
          "A Look: an id bundled with the CLI (video-agent looks lists a server's), or a look folder.",
      },
      out: { type: 'string', description: 'Where the video goes (default ./videos/<slug>).' },
      keep: { type: 'boolean', description: 'Keep the workspace (for debugging).' },
      timeout: { type: 'string', description: 'Give up after this long: 30m, 1h (default 40m).' },
    },
    examples: [
      'video-agent local "A 20-second launch video for our webhooks feature" --aspect 16:9',
      'video-agent local "A product teaser" --voice --sound music --media ./shot.png:"The new dashboard"',
      'video-agent local --look ./looks/my-look "A 20-second launch video for our webhooks feature"',
    ],
    sdk: [],
    local: true,
    ready: true,
  },
  {
    name: 'local revise',
    summary: 'Make the next version of a video you made with local.',
    args: [
      { name: 'dir', type: 'file', required: true, description: 'The video folder (./videos/<slug>).' },
      { name: 'change', type: 'string', required: true, description: 'What to change.' },
    ],
    flags: {
      agent: { type: 'string', description: 'The coding agent: claude.' },
      'from-version': { type: 'number', description: 'The version to change (default: the latest).' },
      scene: {
        type: 'string',
        multiple: true,
        description: 'Only redo these scenes (id or label; repeatable). The rest stay as they are.',
      },
      keep: { type: 'boolean', description: 'Keep the workspace (for debugging).' },
      timeout: { type: 'string', description: 'Give up after this long: 30m, 1h (default 40m).' },
    },
    examples: [
      'video-agent local revise ./videos/webhooks-launch "Make the end card orange"',
      'video-agent local revise ./videos/webhooks-launch --scene demo "Show the preview URL"',
    ],
    sdk: [],
    local: true,
    ready: true,
  },
]

/** The catalog entry for these words, longest match first ("media upload" before "media"). */
export function findCommand(words: string[]): { spec: CommandSpec; used: number } | null {
  for (let n = Math.min(words.length, 3); n > 0; n--) {
    const name = words.slice(0, n).join(' ')
    const spec = COMMANDS.find((c) => c.name === name)
    if (spec) return { spec, used: n }
  }
  return null
}
