// A run gets its callback token without a --token flag: prepare-run moves the manifest's token (no run secret) to
// .va-run/callback.json, readable by this user only, and keeps it out of .render/run-manifest.json; render-job and
// checkpoint take it from VIDEO_AGENT_RUN_SECRET (derived per attempt), else that file, else VA_CALLBACK_TOKEN, else a
// deprecated --token. checkpoint.ts runs for real against a local server with no --token. The server accepts the
// derived token for its own attempt only.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { takeCallback } from '../scripts/prepare-run.js'
import { callbackAuth, CALLBACK_FILE, runSecretMasked, writeCallback } from '../scripts/lib/run-callback.js'
import { sha256Hex } from '../src/lib/crypto.js'
import { runAttemptToken, runTokenOk } from '../src/lib/run-auth.js'
import { RUN_MANIFEST_VERSION, type RunManifest } from '../src/lib/run-manifest.js'

const ATTEMPT = '0b8a2c1e-0000-4000-8000-000000000000'
const TOKEN = randomBytes(24).toString('base64url')
const SECRET = randomBytes(32).toString('base64url')
const manifest = (callback?: { token: string }): RunManifest => ({
  v: RUN_MANIFEST_VERSION,
  jobId: 'vid_1',
  attemptId: ATTEMPT,
  versionN: 1,
  kind: 'author',
  source: null,
  bundle: null,
  media: null,
  feedback: null,
  ...(callback ? { callback } : {}),
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('prepare-run: the callback token', () => {
  it('goes to .va-run/callback.json (0600) and out of the manifest it keeps', () => {
    const root = mkdtempSync(join(tmpdir(), 'va-cb-'))
    const kept = takeCallback(manifest({ token: TOKEN }), root)
    expect(kept.callback).toBeUndefined()
    expect(JSON.stringify(kept)).not.toContain(TOKEN)
    const file = join(root, CALLBACK_FILE)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ attemptId: ATTEMPT, token: TOKEN })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // No token (the run secret is set): nothing written.
    const none = mkdtempSync(join(tmpdir(), 'va-cb-'))
    expect(takeCallback(manifest(), none)).toEqual(manifest())
    expect(() => statSync(join(none, CALLBACK_FILE))).toThrow()
  })
})

describe('render-job and checkpoint: where the token comes from', () => {
  it('the run secret first, then the file (this attempt only), then VA_CALLBACK_TOKEN, then --token', () => {
    const root = mkdtempSync(join(tmpdir(), 'va-cb-'))
    vi.stubEnv('VIDEO_AGENT_RUN_SECRET', '')
    vi.stubEnv('VA_CALLBACK_TOKEN', '')
    expect(callbackAuth(root, ATTEMPT)).toEqual({ token: '', source: 'none' })
    expect(callbackAuth(root, ATTEMPT, 'legacy')).toEqual({ token: 'legacy', source: 'flag' })
    vi.stubEnv('VA_CALLBACK_TOKEN', 'from-env')
    expect(callbackAuth(root, ATTEMPT, 'legacy').source).toBe('env')
    writeCallback(root, { attemptId: 'another-attempt', token: 'other' })
    expect(callbackAuth(root, ATTEMPT).source).toBe('env')
    writeCallback(root, { attemptId: ATTEMPT, token: TOKEN })
    expect(callbackAuth(root, ATTEMPT, 'legacy')).toEqual({ token: TOKEN, source: 'file' })
    vi.stubEnv('VIDEO_AGENT_RUN_SECRET', SECRET)
    expect(callbackAuth(root, ATTEMPT)).toEqual({
      token: runAttemptToken(SECRET, ATTEMPT),
      source: 'run-secret',
    })
  })

  it('reports whether the platform masks the run secret (names only)', () => {
    vi.stubEnv('NETLIFY_SENSITIVE_ENV_KEYS', 'RUNNER_API_TOKEN,VIDEO_AGENT_RUN_SECRET')
    expect(runSecretMasked()).toBe(true)
    vi.stubEnv('NETLIFY_SENSITIVE_ENV_KEYS', 'RUNNER_API_TOKEN')
    expect(runSecretMasked()).toBe(false)
  })

  it('checkpoint.ts posts with the derived token and no --token on its command line', async () => {
    const seen: { auth: string | undefined; body: string }[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"accepted":true,"seq":1}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const args = [
      'tsx',
      'scripts/checkpoint.ts',
      '--attempt',
      ATTEMPT,
      '--url',
      `http://127.0.0.1:${String(port)}/cp`,
      '--message',
      'Writing the end card',
    ]
    // Async, so this process's server can answer while the script runs.
    const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const p = spawn('npx', args, {
        cwd: join(import.meta.dirname, '..'),
        env: { ...process.env, VIDEO_AGENT_RUN_SECRET: SECRET, VA_CALLBACK_TOKEN: '' },
      })
      let out = ''
      p.stdout.on('data', (c: Buffer) => (out += c.toString()))
      p.stderr.on('data', (c: Buffer) => (out += c.toString()))
      p.on('close', (status) => resolve({ status, out }))
    })
    server.close()
    console.log(
      JSON.stringify({ test: 'run-callback', case: 'checkpoint', status: r.status, posts: seen.length }),
    )
    expect(args.join(' ')).not.toContain('--token')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.auth).toBe(`Bearer ${runAttemptToken(SECRET, ATTEMPT)}`)
    expect(r.out).not.toContain(runAttemptToken(SECRET, ATTEMPT))
    expect(r.out).not.toContain(SECRET)
  }, 90_000)
})

describe('the server', () => {
  it('accepts the derived token for its own attempt only, and the attempt’s own token', () => {
    const a = { id: ATTEMPT, callbackTokenHash: sha256Hex(TOKEN) }
    expect(runTokenOk(runAttemptToken(SECRET, ATTEMPT), a, SECRET)).toBe(true)
    expect(runTokenOk(runAttemptToken(SECRET, 'another-attempt'), a, SECRET)).toBe(false)
    expect(runTokenOk(runAttemptToken(SECRET, ATTEMPT), a, null)).toBe(false)
    expect(runTokenOk(TOKEN, a, SECRET)).toBe(true)
    expect(runTokenOk(TOKEN, { ...a, callbackTokenHash: null }, null)).toBe(false)
    expect(runTokenOk(null, a, SECRET)).toBe(false)
  })
})
