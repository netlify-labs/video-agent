// Local mode's checkpoints and workspace (cli-and-sdk plan §7; bead va-p1th.5.1): VA_REPO_ROOT moves every path, and
// a file: checkpoint URL writes 1.json, 2.json… into a folder under <repoRoot>/.render/ (never outside it), with the
// same body the https path POSTs.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** checkpoint.ts and run-tools.ts loaded fresh with VA_REPO_ROOT set to a new workspace. */
async function inWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'va-ws-'))
  mkdirSync(join(ws, 'video'))
  writeFileSync(join(ws, 'video', 'index.html'), '<div>v1</div>')
  vi.stubEnv('VA_REPO_ROOT', ws)
  vi.resetModules()
  const tools = await import('../../scripts/lib/run-tools.js')
  const cp = await import('../../scripts/checkpoint.js')
  return { ws, tools, cp }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('local checkpoints', () => {
  it('VA_REPO_ROOT moves the workspace', async () => {
    const { ws, tools } = await inWorkspace()
    expect(tools.repoRoot).toBe(ws)
  })

  it('writes <seq>.json into the folder, with the bundle when asked, and never calls fetch', async () => {
    const { ws, cp } = await inWorkspace()
    const folder = join(ws, '.render', 'att_1', 'checkpoint')
    const url = pathToFileURL(folder).href
    const fetchImpl = vi.fn<typeof fetch>()
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((l: string) => void lines.push(l))
    expect(
      await cp.postCheckpoint({ attempt: 'att_1', url, token: '', message: 'Writing', fetchImpl }),
    ).toEqual({
      ok: true,
    })
    await cp.postCheckpoint({
      attempt: 'att_1',
      url,
      token: '',
      renderPercent: 41.6,
      bundle: true,
      fetchImpl,
    })
    spy.mockRestore()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(readdirSync(folder).sort()).toEqual(['1.json', '2.json'])
    expect(JSON.parse(readFileSync(join(folder, '1.json'), 'utf8'))).toEqual({ seq: 1, message: 'Writing' })
    const second = JSON.parse(readFileSync(join(folder, '2.json'), 'utf8'))
    expect(second).toMatchObject({ seq: 2, renderPercent: 42 })
    expect(typeof second.bundle).toBe('string')
    expect(lines.map((l) => JSON.parse(l).step)).toEqual([
      'checkpoint.file_written',
      'checkpoint.file_written',
    ])
    // The counter is the same one the https path uses.
    expect(readFileSync(join(ws, '.render', 'checkpoint-seq-att_1'), 'utf8')).toBe('2')
  })

  it('sends no bundle over 2 MB, and says so', async () => {
    const { ws, cp } = await inWorkspace()
    // Random bytes don't compress, so the archive stays over 2 MB.
    writeFileSync(join(ws, 'video', 'noise.bin'), Buffer.from(crypto.getRandomValues(new Uint8Array(65_536))))
    for (let i = 0; i < 40; i++)
      writeFileSync(
        join(ws, 'video', `noise-${i}.bin`),
        Buffer.from(crypto.getRandomValues(new Uint8Array(65_536))),
      )
    const folder = join(ws, '.render', 'att_2', 'checkpoint')
    const r = await cp.postCheckpoint({
      attempt: 'att_2',
      url: pathToFileURL(folder).href,
      token: '',
      bundle: true,
    })
    expect(r).toEqual({ ok: true, reason: 'bundle over 2 MB, sent without it' })
    expect(JSON.parse(readFileSync(join(folder, '1.json'), 'utf8'))).toEqual({ seq: 1 })
  })

  it('refuses a file: URL outside <repoRoot>/.render/', async () => {
    const { ws, cp } = await inWorkspace()
    for (const dir of [join(ws, 'video'), join(ws, '.render', '..', 'x'), tmpdir()]) {
      const r = await cp.postCheckpoint({
        attempt: 'att_3',
        url: pathToFileURL(dir).href,
        token: '',
        message: 'x',
      })
      expect(r.ok).toBe(false)
      expect(r.reason).toMatch(/is outside .*\.render/)
    }
    expect(existsSync(join(ws, 'video', '1.json'))).toBe(false)
  })

  it('an https URL still POSTs the same body with the token', async () => {
    const { cp } = await inWorkspace()
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    await cp.postCheckpoint({
      attempt: 'att_4',
      url: 'https://x.example/cp',
      token: 't',
      message: 'Hi',
      fetchImpl,
    })
    const [, init] = fetchImpl.mock.calls[0]!
    expect(init?.body).toBe(JSON.stringify({ seq: 1, message: 'Hi' }))
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer t')
  })
})
