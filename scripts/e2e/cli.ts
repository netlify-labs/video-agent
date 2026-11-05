// Live check LT-2 for the video-agent CLI against a deployment (cli-and-sdk plan §11 phase 3; bead va-p1th.4.12). It
// runs the real command (packages/cli/src/bin.ts) as a child process with its own config dir, the way a person would.
// Without CREATE_OK=1 it spends no credits; with it, one short video (about CREATE_CREDITS = 150). CREDIT_CEILING
// (default 300) refuses to create once that estimate would pass it.
//
//   npx tsx scripts/e2e/cli.ts --dry    # checks the env and local tools, prints the steps and credits; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… VIDEO_ID=vid_… [CREATE_OK=1] [CREDIT_CEILING=300] \
//     npx tsx scripts/e2e/cli.ts
//
// VIDEO_AGENT_KEY is a Creator's or an Admin's key (given to login on stdin, never on the command line); VIDEO_ID a
// ready video of theirs. Steps, each logged as a JSON line with the exit code and the CLI's request ids:
//   1. login --key - (stdin): checked with GET /me and saved 0600 to a temp config dir; whoami --json.
//   2. list --json --limit 3; get VIDEO_ID --json (a ready latest version).
//   3. download VIDEO_ID --out <tmp>/video.mp4, verified with ffprobe when it's installed.
//   4. publish VIDEO_ID --json, the share page answers 200, then unpublish in a finally. Skipped when VIDEO_ID is
//      already published, so a real publication is never taken down.
//   5. With CREATE_OK=1: create (10 s, silent, an idempotency key) --wait --out <tmp>/created, ffprobe; the video is
//      deleted in a finally.
//   6. logout (never --revoke: the key is yours). No output of any step may contain "nva_".
// Exits non-zero on the first failed check, after cleanup. Work files go to a temp dir, kept on failure.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isVideoAgentError } from '../../packages/sdk/src/index.js'
import { base, key, log, sdk, started } from './lib.js'
import { check, dry, dryRun, GateError } from './narration-lib.js'

const env = process.env
const videoId = env.VIDEO_ID ?? ''
const createOk = env.CREATE_OK === '1'
const ceiling = Number(env.CREDIT_CEILING ?? 300)
const perCreate = Number(env.CREATE_CREDITS ?? 150)
const FFPROBE = env.FFPROBE ?? 'ffprobe'
const tool = (bin: string) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0
const BIN = join(import.meta.dirname, '../../packages/cli/src/bin.ts')

const steps = [
  'login --url <site> --key - (key on stdin) saves a 0600 config in a temp dir; whoami --json',
  'list --json --limit 3; get VIDEO_ID --json (ready)',
  `download VIDEO_ID --out <tmp>/video.mp4${tool(FFPROBE) ? ' verified with ffprobe' : ' (no ffprobe: size only)'}`,
  'publish VIDEO_ID --json, GET the share page (200), unpublish in finally; skipped if already published (no credits)',
  createOk
    ? `CREATE_OK: create (10 s, silent) --wait --out (≈${perCreate} credits), ffprobe; video deleted in finally`
    : 'no video created (set CREATE_OK=1 for one ≈150-credit video)',
  'logout (no --revoke); no "nva_" in any output',
]
if (dry)
  dryRun({
    script: 'scripts/e2e/cli.ts',
    required: {
      VIDEO_AGENT_URL: env.VIDEO_AGENT_URL,
      VIDEO_AGENT_KEY: env.VIDEO_AGENT_KEY,
      VIDEO_ID: videoId,
    },
    optional: {
      CREATE_OK: env.CREATE_OK,
      CREDIT_CEILING: env.CREDIT_CEILING,
      CREATE_CREDITS: env.CREATE_CREDITS,
    },
    steps,
    credits: { projected: createOk ? perCreate : 0, ceiling, perCreate },
    problems: [
      ...(existsSync(BIN) ? [] : [`${BIN} is missing`]),
      ...(ceiling > 0 ? [] : ['CREDIT_CEILING must be a positive number']),
      ...(createOk && perCreate > ceiling
        ? [`CREATE_CREDITS ${perCreate} is over CREDIT_CEILING ${ceiling}`]
        : []),
    ],
  })
if (!base || !key || !videoId)
  throw new Error('Set VIDEO_AGENT_URL, VIDEO_AGENT_KEY and VIDEO_ID (or pass --dry).')

const work = mkdtempSync(join(tmpdir(), 'va-cli-e2e-'))
const configHome = join(work, 'config')
const cleanup: (() => Promise<unknown>)[] = []
let ok = false
let credits = 0

/** One CLI run with only the site in its env: the key comes from the saved config (or stdin for login). */
function vaCli(args: string[], o: { stdin?: string; timeoutMs?: number } = {}) {
  const t = Date.now()
  const rest = { ...env }
  delete rest.VIDEO_AGENT_KEY
  delete rest.VIDEO_AGENT_URL
  const r = spawnSync('npx', ['tsx', BIN, ...args, '--verbose'], {
    encoding: 'utf8',
    input: o.stdin ?? '',
    env: { ...rest, XDG_CONFIG_HOME: configHome },
    timeout: o.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = `${r.stdout}${r.stderr}`
  const requestIds = [...out.matchAll(/"requestId":"([^"]+)"/g)].map((m) => m[1])
  log('cli', { args: args.slice(0, 2), code: r.status, ms: Date.now() - t, requestIds: requestIds.slice(-3) })
  check(!out.includes('nva_'), 'no "nva_" in CLI output', { args: args.slice(0, 1) })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the output's shape
  const lastJson = <T>() => JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as T
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: lastJson }
}

const probe = (path: string) => {
  if (!tool(FFPROBE)) return null
  const r = spawnSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path],
    { encoding: 'utf8' },
  )
  const out = JSON.parse(r.stdout || '{}') as {
    format?: { duration?: string }
    streams?: { codec_type: string }[]
  }
  return {
    duration: Number(out.format?.duration),
    video: Boolean(out.streams?.some((s) => s.codec_type === 'video')),
  }
}

try {
  const login = vaCli(['login', '--url', base, '--key', '-', '--json'], { stdin: key })
  check(login.code === 0, 'login --key -', { code: login.code, stderr: login.stderr.slice(-300) })
  const file = join(configHome, 'video-agent', 'config.json')
  check((statSync(file).mode & 0o777) === 0o600, 'config saved 0600')
  const who = vaCli(['whoami', '--json'])
  const me = who.json<{ user?: { role: string }; features?: string[] }>()
  check(who.code === 0 && ['creator', 'admin'].includes(me.user?.role ?? ''), 'whoami', { code: who.code })
  log('whoami', { role: me.user?.role, features: me.features })

  const list = vaCli(['list', '--json', '--limit', '3'])
  check(list.code === 0 && Array.isArray(list.json<{ items?: unknown[] }>().items), 'list', {
    code: list.code,
  })
  const got = vaCli(['get', videoId, '--json'])
  check(got.code === 0, 'get VIDEO_ID', { code: got.code })
  const video = got.json<{
    latestVersion: number
    versions: { n: number; status: string; publications: { unpublishedAt: string | null }[] }[]
  }>()
  const versions = video.versions
  const latest = versions.find((v) => v.n === video.latestVersion)
  check(latest?.status === 'ready', 'VIDEO_ID needs a ready latest version', { status: latest?.status })

  const mp4 = join(work, 'video.mp4')
  const dl = vaCli(['download', videoId, '--out', mp4])
  const p = existsSync(mp4) ? probe(mp4) : null
  const bytes = existsSync(mp4) ? statSync(mp4).size : 0
  check(dl.code === 0 && bytes > 1000 && (!p || (p.video && p.duration > 0)), 'download', {
    code: dl.code,
    bytes,
    probe: p,
  })
  log('downloaded', { bytes, probe: p })

  if (versions.some((v) => v.publications.some((x) => !x.unpublishedAt)))
    log('publish_skipped', { reason: 'VIDEO_ID is already published' })
  else {
    const pub = vaCli(['publish', videoId, '--json'])
    cleanup.push(async () => {
      const un = vaCli(['unpublish', videoId])
      check(un.code === 0, 'unpublish', { code: un.code })
    })
    check(pub.code === 0, 'publish', { code: pub.code, stderr: pub.stderr.slice(-300) })
    const shareUrl = pub.json<{ urls?: { page?: string } }>().urls?.page
    check(typeof shareUrl === 'string', 'publish returns a share URL')
    const page = await fetch(shareUrl)
    check(page.status === 200, 'share page answers 200', { status: page.status })
    log('published', { status: page.status })
  }

  if (createOk) {
    if (credits + perCreate > ceiling)
      throw new GateError('CREDIT_CEILING reached before create', { credits, ceiling })
    const outDir = join(work, 'created')
    const made = vaCli(
      [
        'create',
        'A 10-second title card that says "CLI check" on a plain background.',
        '--duration',
        '10',
        '--sound',
        'silent',
        '--idempotency-key',
        `cli-e2e-${started}`,
        '--wait',
        '--out',
        outDir,
        '--json',
      ],
      { timeoutMs: 20 * 60_000 },
    )
    const id = made.json<{ id?: string }>().id
    if (id) cleanup.push(() => sdk().videos.delete(id))
    check(made.code === 0 && id !== undefined, 'create --wait --out', {
      code: made.code,
      stderr: made.stderr.slice(-300),
    })
    const files = existsSync(outDir) ? readdirSync(outDir) : []
    const created = files.find((f) => f.endsWith('.mp4'))
    const pc = created ? probe(join(outDir, created)) : null
    check(Boolean(created) && (!pc || pc.video), 'the new video downloaded', { files, probe: pc })
    const ready = await sdk().videos.get(id)
    const rv = ready.versions.find((x) => x.n === ready.latestVersion)
    credits += rv?.usage?.totalCreditsCost ?? perCreate
    log('created_ready', { id, credits: rv?.usage?.totalCreditsCost ?? null, files })
  }

  const out = vaCli(['logout'])
  check(out.code === 0, 'logout', { code: out.code })
  ok = true
} catch (e) {
  log('FAIL', {
    msg: e instanceof Error ? e.message : String(e),
    ...(e instanceof GateError ? e.fields : {}),
    ...(isVideoAgentError(e) ? { code: e.code, status: e.status, requestId: e.requestId } : {}),
  })
} finally {
  for (const c of cleanup.reverse())
    await c().then(
      () => log('cleaned'),
      (e: unknown) => {
        ok = false
        log('cleanup_failed', { error: e instanceof Error ? e.message : String(e) })
      },
    )
  // The saved config holds the key: always removed, even when other work files are kept.
  rmSync(configHome, { recursive: true, force: true })
  if (ok) rmSync(work, { recursive: true, force: true })
  else log('kept', { work })
}
log(ok ? 'PASS' : 'FAILED', { credits, ceiling, sec: Math.round((Date.now() - started) / 1000) })
process.exit(ok ? 0 : 1)
