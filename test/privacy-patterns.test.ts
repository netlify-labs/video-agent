// Privacy mode's matcher (src/lib/privacy-patterns.ts): the recommended patterns find what demos most often show by
// accident, ordinary UI text doesn't match, hide strings match whatever their case, and overlaps keep the longest.
import { describe, expect, it } from 'vitest'
import { findPrivate } from '../src/lib/privacy-patterns.js'

const kinds = (text: string, strings?: string[]) =>
  findPrivate(text, { patterns: true, strings }).map((m) => [m.kind, m.text])

describe('privacy patterns', () => {
  it('finds emails, provider keys, tokens, URLs that carry ids, cards and phone numbers', () => {
    const cases: [string, [string, string][]][] = [
      ['Signed in as ada.okafor@acme-labs.dev.', [['email', 'ada.okafor@acme-labs.dev']]],
      ['Key: sk_live_51HxQwErTyUiOpAsDfGh', [['key', 'sk_live_51HxQwErTyUiOpAsDfGh']]],
      ['ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', [['key', 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8']]],
      ['AWS AKIAIOSFODNN7EXAMPLE here', [['key', 'AKIAIOSFODNN7EXAMPLE']]],
      [
        'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N',
        [['token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N']],
      ],
      [
        'session 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        [['token', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08']],
      ],
      [
        'Open https://app.acme.dev/invite?token=abc123 now',
        [['url', 'https://app.acme.dev/invite?token=abc123']],
      ],
      [
        'https://hooks.acme.dev/v/3f2c1a9e-8b7d-4c6e-9f0a-1b2c3d4e5f6a',
        [['url', 'https://hooks.acme.dev/v/3f2c1a9e-8b7d-4c6e-9f0a-1b2c3d4e5f6a']],
      ],
      ['Card 4242 4242 4242 4242 on file', [['card', '4242 4242 4242 4242']]],
      ['Call +1 415-555-0132 today', [['phone', '+1 415-555-0132']]],
    ]
    for (const [text, want] of cases) {
      const got = kinds(text)
      console.log(JSON.stringify({ test: 'privacy-patterns', text: text.slice(0, 40), got }))
      expect(got, text).toEqual(want)
    }
  })

  it('leaves ordinary demo text alone', () => {
    for (const text of [
      'Org webhooks launch · v1 · 23 s · 1920×1080 · 3 h ago',
      'https://hooks.acme.dev/deploys',
      'Create webhook',
      'deploy.succeeded, deploy.failed, build.started',
      'Order 1234 5678 9012 3456 shipped', // fails Luhn
      'Version 2026-11-06 at 14:05',
    ]) {
      const got = kinds(text)
      expect(got, text).toEqual([])
    }
  })

  it('hide strings match in any case, even with privacy mode off; overlaps keep the longest', () => {
    expect(
      findPrivate('Ada Okafor · ada OKAFOR', { patterns: false, strings: ['ada okafor'] }).map((m) => m.text),
    ).toEqual(['Ada Okafor', 'ada OKAFOR'])
    expect(findPrivate('Acme Labs', { patterns: false, strings: ['a'] })).toEqual([])
    // An email that contains a hide string: one match, the email.
    expect(kinds('ada@acme.dev', ['acme'])).toEqual([['email', 'ada@acme.dev']])
    // Privacy mode off and no strings: nothing.
    expect(findPrivate('ada@acme.dev', { patterns: false })).toEqual([])
  })
})
