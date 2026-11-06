// Finalize reads the saved composition once and stores its beats and whether it's editable with ready (redo a scene,
// docs/plans/2026-11-04-regenerate-beat.md §4.2, owner Q8): `editable` never lags, and scoped revisions and the
// video DTO never unpack an archive for the scene list.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { beatsOf } from '../src/domain/beats.js'
import { bundleContract, readBundleIndex } from '../src/domain/bundles.js'
import { load, NARRATION_SRC, read } from '../src/lib/contract.js'
import type { Store } from '../src/store/types.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')
const music = fixture('contract1-music/index.html')
const enc = (s: string) => new TextEncoder().encode(s)
/** The composition's head also points at the narration bus, so the bus has to count as one of its files. */
const usesBus = (html: string) =>
  html.replace('</head>', `<style>.bus { background: url(${NARRATION_SRC}); }</style></head>`)
const BUS = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 251))

const stores: [string, () => Promise<Store | undefined>][] = [
  ['memory', async () => undefined],
  ['postgres', pgStore],
]

/** Harness options for a store, leaving the default (memory) store alone. */
const opts = async (store: () => Promise<Store | undefined>) => {
  const s = await store()
  return s ? { store: s } : {}
}

async function make(h: Harness, html: string, opts: { bus?: boolean; raw?: Uint8Array } = {}) {
  h.deps.nextSource = opts.raw ?? tarGz([{ name: 'video/index.html', body: html }])
  if (opts.bus) h.deps.nextBus = BUS
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  const row = await h.deps.store.getVersion(v.id as string, 1)
  return { id: v.id as string, row }
}

describe.each(stores)('finalize stores beats and contract with ready (%s)', (_name, store) => {
  it('a contract-v1 version is ready with its beats and contract already set', async () => {
    const h = harness({}, await opts(store))
    // Even when the preview bundle fails afterwards, the version is editable: both were written with ready.
    const set = h.deps.blobs.set.bind(h.deps.blobs)
    h.deps.blobs.set = async (s, k, b, m) => {
      if (s === 'bundles') throw new Error('bundles are down')
      return set(s, k, b, m)
    }
    const { row } = await make(h, music)
    expect(row?.status).toBe('ready')
    expect(row?.contract).toBe(1)
    expect(row?.beats).toEqual(
      read(load(music)).beats.map((b) => ({
        id: b.id,
        label: b.label,
        start: b.start,
        duration: b.duration,
      })),
    )
    expect(row?.beats?.map((b) => [b.id, b.label])).toEqual([
      ['intro', 'Opening'],
      ['demo', null],
      ['outro', null],
    ])
    expect(h.deps.logs.some((l) => l.includes('finalize.bundle_failed'))).toBe(true)
    expect(h.deps.logs.some((l) => l.includes('finalize.beats'))).toBe(true)
  })

  it('a composition missing a file it uses is not editable, as the bundle says', async () => {
    const h = harness({}, await opts(store))
    const { id, row } = await make(h, usesBus(music))
    expect(row?.contract ?? null).toBeNull()
    expect(row?.beats).toHaveLength(3)
    expect((await readBundleIndex(h.deps, id, 1))?.contract).toEqual({
      version: null,
      violations: [`It uses files that weren't saved: ${NARRATION_SRC}.`],
    })
    expect(h.deps.logs.some((l) => l.includes('finalize.contract_mismatch'))).toBe(false)
  })

  it("counts a narrated version's bus (a reference file) as present", async () => {
    const h = harness({}, await opts(store))
    const { id, row } = await make(h, usesBus(music), { bus: true })
    expect(row?.contract).toBe(1)
    expect((await readBundleIndex(h.deps, id, 1))?.contract?.version).toBe(1)
  })

  it('a free-form composition has no beats and no contract', async () => {
    const h = harness({}, await opts(store))
    const { row } = await make(h, '<!doctype html><h1>free-form</h1>')
    expect(row?.status).toBe('ready')
    expect(row?.contract ?? null).toBeNull()
    expect(row?.beats ?? null).toBeNull()
  })
})

describe('finalize with an unreadable archive', () => {
  it('is still ready, with no beats, contract or run credits, and says why', async () => {
    const h = harness()
    const { row } = await make(h, '', { raw: enc('not a tarball') })
    expect(row?.status).toBe('ready')
    expect(row?.contract ?? null).toBeNull()
    expect(row?.beats ?? null).toBeNull()
    expect(h.deps.logs.some((l) => l.includes('finalize.source_unreadable'))).toBe(true)
  })
})

describe('beatsOf and bundleContract', () => {
  it('reads beats only from a declared contract-v1 composition', () => {
    expect(beatsOf(new Map([['index.html', enc(music)]]))?.map((b) => b.id)).toEqual([
      'intro',
      'demo',
      'outro',
    ])
    expect(beatsOf(new Map([['index.html', enc('<h1>hi</h1>')]]))).toBeNull()
    expect(beatsOf(new Map([['index.html', enc('<div data-va-contract="1">no root</div>')]]))).toBeNull()
    expect(beatsOf(new Map())).toBeNull()
  })

  it('gives what the bundle used to compute inline', () => {
    const files = (html: string) => new Map([['index.html', enc(html)]])
    expect(bundleContract('hyperframes', files(music))).toEqual({ version: 1, violations: [] })
    expect(bundleContract('hyperframes', files(usesBus(music)))).toEqual({
      version: null,
      violations: [`It uses files that weren't saved: ${NARRATION_SRC}.`],
    })
    expect(bundleContract('hyperframes', new Map([...files(usesBus(music)), [NARRATION_SRC, BUS]]))).toEqual({
      version: 1,
      violations: [],
    })
    expect(bundleContract('hyperframes', files('<h1>free</h1>')).version).toBeNull()
  })
})
