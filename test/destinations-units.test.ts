// Publish destinations, pure parts (§2.2, §3.4, §6.3): target validation, the options-form subset, safe text.
import { describe, expect, it } from 'vitest'
import { validTarget, validateTargets } from '../src/domain/destinations/targets.js'
import { safeText, safeWarnings } from '../src/domain/destinations/types.js'
import { parseOptionsSchema, validateOptions } from '../src/lib/options-schema.js'

const t = (over: object = {}) => ({
  id: 'site-1',
  name: 'Acme',
  description: null,
  url: null,
  metadata: null,
  ...over,
})

describe('targets', () => {
  it('accepts the generic shape and keeps metadata as is', () => {
    expect(
      validTarget(t({ url: 'https://acme.netlify.app/', metadata: { videos: 3, ok: true, n: null } })),
    ).toEqual({
      id: 'site-1',
      name: 'Acme',
      description: null,
      url: 'https://acme.netlify.app/',
      metadata: { videos: 3, ok: true, n: null },
    })
  })
  it('refuses broken entries', () => {
    expect(validTarget(t({ id: '' }))).toBeNull()
    expect(validTarget(t({ name: 'x'.repeat(201) }))).toBeNull()
    expect(validTarget(t({ description: 'x'.repeat(501) }))).toBeNull()
    expect(validTarget(t({ url: 'http://insecure.example.com' }))).toBeNull()
    expect(validTarget(t({ url: 'https://user:pw@example.com' }))).toBeNull()
    expect(validTarget(t({ metadata: { nested: { a: 1 } } }))).toBeNull()
    expect(
      validTarget(t({ metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) })),
    ).toBeNull()
    expect(validTarget(t({ metadata: { big: 'x'.repeat(2100) } }))).toBeNull()
    expect(validTarget(t({ metadata: { inf: Infinity } }))).toBeNull()
    expect(validTarget('nope')).toBeNull()
  })
  it('drops bad entries and duplicates, caps at 100, keeps the order', () => {
    const raw = [
      t({ id: 'b' }),
      t({ id: '' }),
      t({ id: 'a' }),
      t({ id: 'b' }),
      ...Array.from({ length: 120 }, (_, i) => t({ id: `x${i}` })),
    ]
    const r = validateTargets(raw)
    expect(r.targets).toHaveLength(100)
    expect(r.targets.slice(0, 2).map((x) => x.id)).toEqual(['b', 'a'])
    expect(r.dropped).toBe(raw.length - 100)
    expect(validateTargets({})).toEqual({ targets: [], dropped: 0 })
  })
})

describe('options forms', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Site name', maxLength: 40 },
      layout: { type: 'string', enum: ['hero', 'grid'], default: 'hero' },
      password: { type: 'boolean', title: 'Password-protect it', default: false },
    },
    required: ['name'],
  }
  it('parses the subset', () => {
    const p = parseOptionsSchema(schema)
    expect(p.ok).toBe(true)
  })
  it('refuses what it does not support, naming the path', () => {
    expect(parseOptionsSchema({ ...schema, properties: { n: { type: 'integer' } } })).toEqual({
      ok: false,
      error: 'properties.n.type must be "string" or "boolean".',
    })
    expect(parseOptionsSchema({ ...schema, extra: 1 })).toMatchObject({ ok: false })
    expect(
      parseOptionsSchema({ type: 'object', properties: { a: { type: 'string', pattern: 'x' } } }),
    ).toMatchObject({
      ok: false,
      error: 'properties.a: unknown key "pattern".',
    })
    expect(
      parseOptionsSchema({
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`o${i}`, { type: 'boolean' }])),
      }),
    ).toMatchObject({ ok: false })
    expect(parseOptionsSchema({ ...schema, required: ['nope'] })).toMatchObject({ ok: false })
    expect(
      parseOptionsSchema({
        type: 'object',
        properties: { l: { type: 'string', enum: ['a'], default: 'b' } },
      }),
    ).toMatchObject({ ok: false })
  })
  it('validates values with defaults, refusing unknown keys', () => {
    const p = parseOptionsSchema(schema)
    if (!p.ok) throw new Error(p.error)
    expect(validateOptions(p.value, { name: 'acme' })).toEqual({
      ok: true,
      value: { name: 'acme', layout: 'hero', password: false },
    })
    expect(validateOptions(p.value, {})).toMatchObject({ ok: false, errors: ['"Site name" is required.'] })
    expect(validateOptions(p.value, { name: 'a', layout: 'list' })).toMatchObject({ ok: false })
    expect(validateOptions(p.value, { name: 'x'.repeat(41) })).toMatchObject({ ok: false })
    expect(validateOptions(p.value, { name: 'a', password: 'yes' })).toMatchObject({ ok: false })
    expect(validateOptions(p.value, { name: 'a', extra: 1 })).toMatchObject({
      ok: false,
      errors: ['Unknown option "extra".'],
    })
    expect(validateOptions(null, {})).toEqual({ ok: true, value: {} })
    expect(validateOptions(null, { any: 1 })).toMatchObject({ ok: false })
  })
})

describe('safe text', () => {
  it('is plain, short and never empty', () => {
    expect(safeText('  hi\u0000there\n ')).toBe('hi there')
    expect(safeText('x'.repeat(400))).toHaveLength(300)
    expect(safeText('')).toBeNull()
    expect(safeText(42)).toBeNull()
    expect(safeWarnings(['a', 1, 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(safeWarnings('a')).toBeUndefined()
  })
})
