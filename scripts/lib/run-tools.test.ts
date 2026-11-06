// A run never prints a Remotion secret key (render-engines plan §5.5): log() and runStreaming's kept output mask
// anything shaped like one, and the configured key's own value.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { log, maskSecrets, runStreaming } from './run-tools.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('secret masking', () => {
  it('masks rm_sec_ keys and the configured key, and leaves other text alone', () => {
    expect(maskSecrets('key=rm_sec_AbC-123_x done', undefined)).toBe('key=rm_sec_*** done')
    expect(maskSecrets('the key is s3cr3t-value-1', 's3cr3t-value-1')).toBe('the key is ***')
    expect(maskSecrets('nothing to see, free-license', 's3cr3t-value-1')).toBe('nothing to see, free-license')
    // A short configured value is never treated as a key (it would mask ordinary words).
    expect(maskSecrets('abc abc', 'abc')).toBe('abc abc')
  })

  it('log() masks what it writes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    log('engine.render', { detail: 'licenseKey rm_sec_live_9z' })
    expect(String(spy.mock.calls[0]?.[0])).toContain('rm_sec_***')
    expect(String(spy.mock.calls[0]?.[0])).not.toContain('rm_sec_live_9z')
  })

  it("runStreaming's error tail is masked", async () => {
    vi.stubEnv('VIDEO_AGENT_REMOTION_KEY', 'configured-key-value')
    const err = await runStreaming('sh', ['-c', 'echo rm_sec_abc123 configured-key-value; exit 3'], {
      timeoutMs: 10_000,
    }).catch((e: unknown) => String(e))
    expect(err).toContain('rm_sec_***')
    expect(err).not.toContain('rm_sec_abc123')
    expect(err).not.toContain('configured-key-value')
  })
})
