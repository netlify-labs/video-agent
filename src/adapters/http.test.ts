import { describe, expect, it } from 'vitest'
import { createSafeHttp, expandIPv6, isPrivateAddress, resolvePublic } from './http.js'

describe('isPrivateAddress (plan v2 §14 rule 12)', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['192.168.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['8.8.8.8', false],
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['ff02::1', true],
    ['2001:db8::1', true],
    ['2606:4700:4700::1111', false],
    // IPv4-mapped loopback in every notation
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['0:0:0:0:0:ffff:7f00:0001', true],
    ['::ffff:169.254.169.254', true],
    ['::ffff:a9fe:a9fe', true],
    ['::ffff:8.8.8.8', false],
    // IPv4-compatible and NAT64 forms
    ['::127.0.0.1', true],
    ['64:ff9b::7f00:1', true],
    ['64:ff9b::808:808', false],
    ['not-an-ip', true],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected)
  })

  it('expands IPv6 forms', () => {
    expect(expandIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    expect(expandIPv6('1::2::3')).toBeNull()
  })
})

describe('resolvePublic', () => {
  it('pins the first validated address and rejects any private answer (rebinding)', async () => {
    let calls = 0
    const resolver = async () => {
      calls++
      return [{ address: '93.184.216.34', family: 4 }]
    }
    expect(await resolvePublic('hooks.example.com', resolver)).toEqual({
      address: '93.184.216.34',
      family: 4,
    })
    expect(calls).toBe(1)
    const rebinding = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]
    await expect(resolvePublic('evil.example.com', rebinding)).rejects.toThrow(/private address/)
    await expect(resolvePublic('::ffff:7f00:1')).rejects.toThrow(/private address/)
  })
})

describe('postJsonForResponse (publish destinations §3.1)', () => {
  const opts = { timeoutMs: 2000, maxBodyBytes: 1024 }
  it('refuses http, credentials in the URL, and hosts that resolve to private addresses (even one of many)', async () => {
    const http = createSafeHttp(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])
    await expect(http.postJsonForResponse('http://r.example.com/x', '{}', {}, opts)).rejects.toThrow(/https/)
    await expect(http.postJsonForResponse('https://u:p@r.example.com/x', '{}', {}, opts)).rejects.toThrow(
      /credentials/,
    )
    await expect(http.postJsonForResponse('https://r.example.com/x', '{}', {}, opts)).rejects.toThrow(
      /private/,
    )
    await expect(http.postJsonForResponse('https://127.0.0.1/x', '{}', {}, opts)).rejects.toThrow(/private/)
    await expect(http.postJsonForResponse('https://[::1]/x', '{}', {}, opts)).rejects.toThrow(/private/)
  })
})
