// The action's scaffold (bead va-mg4i.2.1): action.yml matches src/spec.ts, the logger's format and redaction, and the
// committed bundle runs on its own.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Core } from '../src/core.js'
import { envCore } from '../src/core.js'
import { createLog, redact } from '../src/log.js'
import { INPUTS, OUTPUTS } from '../src/spec.js'

const root = join(import.meta.dirname, '..')
const tmp = mkdtempSync(join(tmpdir(), 'action-scaffold-'))
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** action.yml's inputs and outputs: name → default (undefined for none). The file's shape is fixed, so lines do. */
function actionYml() {
  const lines = readFileSync(join(root, 'action.yml'), 'utf8').split('\n')
  const inputs = new Map<string, string | undefined>()
  const outputs = new Map<string, string | undefined>()
  const sections: Record<string, Map<string, string | undefined>> = { inputs, outputs }
  let section: string | null = null
  let current: string | null = null
  for (const line of lines) {
    const top = /^([a-z]+):/.exec(line)
    if (top) {
      section = top[1] ?? null
      current = null
      continue
    }
    const entry = /^ {2}([a-z0-9-]+):$/.exec(line)
    const target = section ? sections[section] : undefined
    if (entry && target) {
      current = entry[1] ?? null
      if (current) target.set(current, undefined)
      continue
    }
    const def = /^ {4}default: (.*)$/.exec(line)
    if (def && current && section === 'inputs')
      inputs.set(current, (def[1] ?? '').replace(/^(['"])(.*)\1$/, '$2'))
  }
  return { inputs, outputs, text: lines.join('\n') }
}

describe('action.yml', () => {
  it('lists exactly the 21 inputs and 13 outputs of src/spec.ts, with the same defaults', () => {
    const yml = actionYml()
    expect(INPUTS).toHaveLength(21)
    expect(OUTPUTS).toHaveLength(13)
    expect([...yml.inputs.keys()]).toEqual(INPUTS.map((i) => i.name))
    expect([...yml.outputs.keys()]).toEqual(OUTPUTS.map((o) => o.name))
    for (const i of INPUTS)
      expect(yml.inputs.get(i.name), i.name).toBe('default' in i ? i.default : undefined)
    // url and api-key are checked in code, after the fork check, so a fork PR without secrets doesn't fail the build.
    expect(yml.text).not.toMatch(/required: true/)
    expect(yml.text).toMatch(/\n {2}using: node24\n {2}main: dist\/index\.cjs\n/)
  })
})

/** A Core that records what it was told. */
function recorder() {
  const lines: string[] = []
  const core: Core = {
    getInput: () => '',
    setOutput: (n, v) => lines.push(`output ${n}=${v}`),
    setSecret: (v) => lines.push(`mask ${v}`),
    info: (m) => lines.push(m),
    warning: (m) => lines.push(`warning ${m}`),
    setFailed: (m) => lines.push(`failed ${m}`),
    startGroup: (n) => lines.push(`group ${n}`),
    endGroup: () => lines.push('endgroup'),
    summary: (m) => lines.push(`summary ${m}`),
  }
  return { core, lines }
}

describe('logger', () => {
  it('writes video-agent: key=value lines, quoting values with spaces, leaving out undefined', () => {
    const { core, lines } = recorder()
    const log = createLog(core)
    log.decision('create', { reason: 'label added', pr: 123, dry: false, tag: undefined })
    log.api({ method: 'POST', path: '/api/v1/videos', status: 202, ms: 41 })
    log.gh({
      method: 'GET',
      route: '/repos/{owner}/{repo}/pulls/{pull_number}',
      status: 200,
      ms: 12,
      remaining: 998,
    })
    log.line({ empty: '', quote: 'say "hi"' })
    expect(lines).toEqual([
      'video-agent: decision=create reason="label added" pr=123 dry=false',
      'video-agent: api=POST path=/api/v1/videos status=202 ms=41',
      'video-agent: gh=GET route=/repos/{owner}/{repo}/pulls/{pull_number} status=200 ms=12 remaining=998',
      'video-agent: empty="" quote="say \\"hi\\""',
    ])
  })

  it('prints one JSON object per line with VIDEO_AGENT_LOG=json', () => {
    const { core, lines } = recorder()
    createLog(core, { json: true }).decision('none', { reason: 'nothing to do' })
    expect(JSON.parse(lines[0] ?? '')).toEqual({ decision: 'none', reason: 'nothing to do' })
  })

  it('redacts the key, bearer tokens, cookies and bare nva_ tokens', () => {
    const key = 'nva_k1_secretsecret'
    const { core, lines } = recorder()
    const log = createLog(core, { secrets: [] })
    log.addSecret(key)
    log.line({
      a: `key ${key}`,
      b: 'Authorization: Bearer abc.def',
      c: 'cookie: nf_jwt=xyz; other=1',
      d: 'nva_other_token',
    })
    log.warn('sent with authorization=token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    // The first line is the mask command itself; everything after it must be clean.
    expect(lines[0]).toBe(`mask ${key}`)
    const text = lines.slice(1).join('\n')
    expect(text).not.toContain('secretsecret')
    expect(text).not.toContain('abc.def')
    expect(text).not.toContain('nf_jwt=xyz')
    expect(text).not.toContain('nva_other_token')
    expect(text).not.toContain('ghp_aaaa')
    expect(redact('a nva_x_y b', [])).toBe('a nva_*** b')
  })

  it('nests groups and closes them when the work throws', async () => {
    const { core, lines } = recorder()
    const log = createLog(core)
    await log.group('outer', () => log.group('inner', async () => log.line({ x: 1 })))
    await expect(log.group('boom', () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(lines).toEqual([
      'group outer',
      'group inner',
      'video-agent: x=1',
      'endgroup',
      'endgroup',
      'group boom',
      'endgroup',
    ])
  })
})

describe('core', () => {
  it('reads INPUT_ variables and writes outputs and the summary to their files', () => {
    const out = join(tmp, 'out')
    const summary = join(tmp, 'summary')
    writeFileSync(out, '')
    writeFileSync(summary, '')
    const written: string[] = []
    const core = envCore(
      { 'INPUT_API-KEY': ' nva_x ', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
      (l) => written.push(l),
    )
    expect(core.getInput('api-key')).toBe('nva_x')
    expect(core.getInput('missing')).toBe('')
    core.setOutput('video-id', 'vid_1')
    core.setOutput('prompt', 'two\nlines')
    core.summary('## Video')
    core.warning('50% done\nnext')
    expect(readFileSync(out, 'utf8')).toMatch(
      /^video-id<<(ghadelimiter_\S+)\nvid_1\n\1\nprompt<<(ghadelimiter_\S+)\ntwo\nlines\n\2\n$/,
    )
    expect(readFileSync(summary, 'utf8')).toBe('## Video\n')
    expect(written).toEqual(['::warning::50%25 done%0Anext'])
  })
})

describe('bundle', () => {
  it('is current, and runs on its own: a push with no inputs does nothing and exits 0', () => {
    execFileSync('npx', ['tsx', join(root, 'scripts/build.ts'), '--check'], { stdio: 'pipe' })
    const event = join(tmp, 'event.json')
    const out = join(tmp, 'bundle-out')
    writeFileSync(event, '{}')
    writeFileSync(out, '')
    const stdout = execFileSync('node', [join(root, 'dist/index.cjs')], {
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: out,
      },
      encoding: 'utf8',
    })
    expect(stdout).toContain('video-agent: decision=none reason="nothing to do for event push"')
    expect(readFileSync(out, 'utf8')).toMatch(/^status<<\S+\nnone\n/)
  })
})
