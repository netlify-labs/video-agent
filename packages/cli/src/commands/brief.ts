// brief pr, brief release, brief changelog: the GitHub Action's briefs from
// any CI system, printed on stdout for `create --prompt-file -`. Local: they read GitHub (GH_TOKEN or GITHUB_TOKEN when
// set; public repos work without) and never call a Video Agent server. --json prints the whole brief (title,
// reference, durationSec, removed, warnings, and context with --context).
import { readFile } from 'node:fs/promises'
import { changelogBrief, prBrief, releaseBrief, type Brief } from '../brief/index.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import type { Ctx, Handler } from '../router.js'
import { arg } from './shared.js'

const str = (ctx: Ctx, flag: string) => {
  const v = ctx.flags[flag]
  return typeof v === 'string' ? v : undefined
}

/** { [key]: value } when the flag was given, {} otherwise. */
const opt = <K extends string>(key: K, value: string | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>

/** owner/name from --repo, else GITHUB_REPOSITORY (GitHub Actions), else a usage error. */
function repoOf(ctx: Ctx): { owner: string; repo: string } {
  const full = str(ctx, 'repo') ?? ctx.io.env.GITHUB_REPOSITORY ?? ''
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(full)
  if (!m?.[1] || !m[2]) throw new UsageError('Say which repository: --repo owner/name.')
  return { owner: m[1], repo: m[2] }
}

/** A GitHub REST call through the CLI's fetch. */
async function github<T>(ctx: Ctx, path: string): Promise<T> {
  const api = (ctx.io.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')
  const token = ctx.io.env.GH_TOKEN ?? ctx.io.env.GITHUB_TOKEN
  const res = await ctx.io.fetch(`${api}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'video-agent-cli',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  ctx.log('github', { path: path.split('?')[0], status: res.status })
  if (res.status === 404)
    throw new CliError(
      'not_found',
      `GitHub has no ${path.split('?')[0]} (or the token can't see it).`,
      EXIT.notFound,
    )
  if (!res.ok) throw new CliError('github', `GitHub answered ${res.status} for ${path.split('?')[0]}.`)
  return (await res.json()) as T
}

async function pages<T>(ctx: Ctx, path: string, max = 300): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; out.length < max; page++) {
    const items = await github<T[]>(ctx, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    out.push(...items)
    if (items.length < 100) break
  }
  return out.slice(0, max)
}

const result = (brief: Brief) => ({ json: brief, text: `${brief.prompt}\n` })

const prCmd: Handler = async (ctx) => {
  const url = arg(ctx, 0, 'pr')
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url)
  if (!m?.[1] || !m[2] || !m[3])
    throw new UsageError('Give a pull request URL: https://github.com/<owner>/<repo>/pull/<n>.')
  const [owner, repo, n] = [m[1], m[2], Number(m[3])]
  const base = `/repos/${owner}/${repo}/pulls/${n}`
  const pull = await github<{ title: string; body: string | null; html_url: string; changed_files?: number }>(
    ctx,
    base,
  )
  const commits = await pages<{ commit: { message: string } }>(ctx, `${base}/commits`)
  const files = await pages<{ filename: string }>(ctx, `${base}/files`)
  // You run it yourself, so the author's words are used unless you say otherwise (the action checks permissions).
  const trusted = !ctx.flags.untrusted
  return result(
    prBrief({
      owner,
      repo,
      number: n,
      title: pull.title,
      body: pull.body,
      commits: commits.map((c) => c.commit.message),
      files: files.map((f) => f.filename),
      filesTotal: pull.changed_files ?? files.length,
      authorTrusted: trusted,
      ...opt('extra', str(ctx, 'prompt')),
      ...(ctx.flags.context ? { withContext: { url: pull.html_url } } : {}),
    }),
  )
}

const releaseCmd: Handler = async (ctx) => {
  const tag = arg(ctx, 0, 'tag')
  const { owner, repo } = repoOf(ctx)
  const notesFile = str(ctx, 'notes-file')
  let body: string
  let name: string | null = null
  let url: string | undefined
  if (notesFile) body = notesFile === '-' ? await ctx.io.stdin() : await readFile(notesFile, 'utf8')
  else {
    const rel = await github<{ name: string | null; body: string | null; html_url: string }>(
      ctx,
      `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    )
    body = rel.body ?? ''
    name = rel.name
    url = rel.html_url
  }
  return result(
    releaseBrief({
      owner,
      repo,
      tag,
      name,
      body,
      ...opt('extra', str(ctx, 'prompt')),
      ...opt('url', str(ctx, 'url')),
      ...(ctx.flags.context ? { withContext: url ? { url } : {} } : {}),
    }),
  )
}

const changelogCmd: Handler = async (ctx) => {
  const since = str(ctx, 'since')
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new UsageError('Say from when: --since YYYY-MM-DD.')
  const { owner, repo } = repoOf(ctx)
  const q = encodeURIComponent(`repo:${owner}/${repo} is:pr is:merged merged:>=${since}`)
  const found = await github<{ items: { number: number; title: string }[] }>(
    ctx,
    `/search/issues?q=${q}&sort=updated&order=desc&per_page=100`,
  )
  return result(
    changelogBrief({
      repo,
      since,
      prs: found.items.map((i) => ({ number: i.number, title: i.title })),
      ...opt('extra', str(ctx, 'prompt')),
      ...opt('url', str(ctx, 'url')),
    }),
  )
}

export const BRIEF_COMMANDS: Record<string, Handler> = {
  'brief pr': prCmd,
  'brief release': releaseCmd,
  'brief changelog': changelogCmd,
}
