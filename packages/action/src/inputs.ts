// The action's inputs, parsed and checked (github-action plan §3.4, bead va-mg4i.2.3). url and api-key are checked
// separately, after the fork check (§4.4), so a fork PR without secrets skips instead of failing the build.
import type { Core } from './core.js'
import type { InputName } from './spec.js'

export class InputError extends Error {
  override readonly name = 'InputError'
  constructor(
    readonly input: string,
    message: string,
  ) {
    super(`${input}: ${message}`)
  }
}

export type Target = { kind: 'pr'; number: number } | { kind: 'release'; tag: string }
export type Screenshots = { kind: 'none' } | { kind: 'body' } | { kind: 'glob'; pattern: string }

export interface Inputs {
  url: string
  apiKey: string
  target: Target | null
  prompt: string
  baseVideo: string
  aspect: '16:9' | '9:16' | '1:1' | '4:5'
  /** null: the kind's default (PR 30, release 45). */
  duration: number | null
  look: string
  label: string
  onPush: 'ignore' | 'revise'
  maxVersions: number
  maxRunsPerDay: number
  maxCreditsPerMonth: number | null
  screenshots: Screenshots
  publish: boolean
  private: boolean
  timeoutMinutes: number
  releaseAsset: boolean
  trust: 'members' | 'forks'
  dryRun: boolean
  githubToken: string
}

const ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const

function oneOf<T extends string>(name: string, value: string, options: readonly T[]): T {
  if ((options as readonly string[]).includes(value)) return value as T
  throw new InputError(name, `must be ${options.join(', ')} (got "${value}")`)
}

function positiveInt(name: string, value: string, min = 1): number {
  if (!/^\d+$/.test(value) || Number(value) < min)
    throw new InputError(name, `must be a whole number of at least ${min} (got "${value}")`)
  return Number(value)
}

function bool(name: string, value: string): boolean {
  if (value === 'true') return true
  if (value === 'false' || value === '') return false
  throw new InputError(name, `must be true or false (got "${value}")`)
}

export function parseTarget(value: string): Target | null {
  if (!value) return null
  const pr = /^pr\/(\d+)$/.exec(value)
  if (pr) return { kind: 'pr', number: Number(pr[1]) }
  const rel = /^release\/(\S+)$/.exec(value)
  if (rel?.[1]) return { kind: 'release', tag: rel[1] }
  throw new InputError('target', `must be pr/<number> or release/<tag> (got "${value}")`)
}

/** Reads and checks every input except url and api-key's format. Throws InputError naming the input. */
export function readInputs(core: Pick<Core, 'getInput'>): Inputs {
  const get = (name: InputName, fallback = '') => core.getInput(name) || fallback
  const screenshots = get('screenshots', 'body')
  const inputs: Inputs = {
    url: get('url').replace(/\/+$/, ''),
    apiKey: get('api-key'),
    target: parseTarget(get('target')),
    prompt: get('prompt'),
    baseVideo: get('base-video'),
    aspect: oneOf('aspect', get('aspect', '16:9'), ASPECTS),
    duration: get('duration') ? positiveInt('duration', get('duration')) : null,
    look: get('look'),
    // An explicitly empty label means "no label needed"; GitHub passes the default when the input is left out.
    label: core.getInput('label'),
    onPush: oneOf('on-push', get('on-push', 'ignore'), ['ignore', 'revise'] as const),
    maxVersions: positiveInt('max-versions', get('max-versions', '3')),
    maxRunsPerDay: positiveInt('max-runs-per-day', get('max-runs-per-day', '10')),
    maxCreditsPerMonth: null,
    screenshots:
      screenshots === 'none' || screenshots === 'body'
        ? { kind: screenshots }
        : { kind: 'glob', pattern: screenshots },
    publish: bool('publish', get('publish')),
    private: bool('private', get('private')),
    timeoutMinutes: positiveInt('timeout-minutes', get('timeout-minutes', '30'), 0),
    releaseAsset: bool('release-asset', get('release-asset')),
    trust: oneOf('trust', get('trust', 'members'), ['members', 'forks'] as const),
    dryRun: bool('dry-run', get('dry-run')),
    githubToken: get('github-token'),
  }
  const credits = get('max-credits-per-month')
  if (credits) {
    if (!/^\d+(\.\d+)?$/.test(credits) || Number(credits) <= 0)
      throw new InputError('max-credits-per-month', `must be a positive number (got "${credits}")`)
    inputs.maxCreditsPerMonth = Number(credits)
  }
  if (inputs.baseVideo && !/^vid_[0-9a-z]+$/.test(inputs.baseVideo))
    throw new InputError('base-video', `must be a video id like vid_01jc… (got "${inputs.baseVideo}")`)
  if (inputs.private && inputs.publish)
    throw new InputError(
      'private',
      "can't be used with publish: publishing makes the files public and the server doesn't check private when publishing. Pick one.",
    )
  return inputs
}

/** Checks that depend on the repository's visibility (release assets on a public repo are public files). */
export function checkVisibility(inputs: Inputs, repoPrivate: boolean) {
  if (repoPrivate || !inputs.releaseAsset) return
  if (inputs.private)
    throw new InputError(
      'private',
      "can't be used with release-asset on a public repo: a release asset is a public file. Pick one.",
    )
  if (!inputs.publish)
    throw new InputError('release-asset', 'on a public repo publishes the video: set publish: true')
}

/** The connection inputs, checked after the fork check. */
export function checkConnection(inputs: Inputs) {
  if (!inputs.url) throw new InputError('url', 'is required (your Video Agent site, an org-level variable)')
  let u: URL
  try {
    u = new URL(inputs.url)
  } catch {
    throw new InputError('url', `isn't a URL (got "${inputs.url}")`)
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))
    throw new InputError('url', 'must be https (http only for localhost)')
  if (!inputs.apiKey) throw new InputError('api-key', 'is required (an nva_ key from a secret)')
  if (!inputs.apiKey.startsWith('nva_')) throw new InputError('api-key', 'must be a Video Agent key (nva_…)')
}
