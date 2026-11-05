// Styles in a scoped beat (redo a scene, plan §4.6): one prelude-less @scope, an at-rule allow-list, nothing global.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { attr, load, validate, walk } from './contract.js'
import { scopedStyleProblems } from './scope-style.js'

const fixture = readFileSync(
  new URL('../../test/fixtures/scope/styles/scoped-demo.html', import.meta.url),
  'utf8',
)

const beatIn = (html: string, id: string) => {
  const b = [...walk(load(html).root)].find((e) => attr(e, 'data-va-beat') === id)
  if (!b) throw new Error(`no beat ${id}`)
  return b
}
/** A Features scene holding `inner`. */
const scene = (inner: string) =>
  beatIn(
    `<div data-composition-id="main"><section data-va-beat="features" data-va-label="Features" data-composition-id="features">${inner}</section></div>`,
    'features',
  )
const styled = (css: string) =>
  scopedStyleProblems(scene(`<style>${css}</style><div class="card"></div>`), 'features')
const one = (css: string) => {
  const p = styled(css)
  expect(p).toHaveLength(1)
  expect(p[0]).toMatch(/^Scene "Features"/)
  return p[0]
}

describe('scoped beat styles', () => {
  it('accepts the fixture, which still keeps contract v1', () => {
    expect(scopedStyleProblems(beatIn(fixture, 'demo'), 'demo')).toEqual([])
    expect(validate(fixture)).toEqual([])
  })

  it('the B1 render fixture keeps contract v1 and passes the check (spikes/b1/b1.ts renders it)', () => {
    const b1 = readFileSync(new URL('../../test/fixtures/scope/at-scope/index.html', import.meta.url), 'utf8')
    expect(validate(b1)).toEqual([])
    expect(scopedStyleProblems(beatIn(b1, 'two'), 'two')).toEqual([])
    expect(scopedStyleProblems(beatIn(b1, 'three'), 'three')).toHaveLength(1)
    expect(scopedStyleProblems(beatIn(b1, 'three'), 'three', { allowPrelude: true })).toEqual([])
  })

  it('accepts a prelude-less @scope with allowed at-rules, assets urls and colour roles', () => {
    expect(
      styled(`@scope {
        .card { background: url(assets/beats/features/a.png), url("assets/x.svg"); color: var(--va-color-surface); }
        .card { background-image: image-set("assets/beats/features/a.png" 1x); }
        @media (min-width: 10px) { .card { padding: 1px } }
        @supports (display: grid) { .card { display: grid } }
        @container (min-width: 400px) { .card { gap: 1px } }
        @keyframes features-pulse { from { opacity: 0 } to { opacity: 1 } }
        :scope > .card, & .card, .card:has(> img) { margin: 0 }
      }`),
    ).toEqual([])
    expect(
      scopedStyleProblems(scene('<div style="color: var(--va-color-text); --x: 1px"></div>'), 'features'),
    ).toEqual([])
    expect(scopedStyleProblems(scene('<p>No styles at all</p>'), 'features')).toEqual([])
  })

  it('names the scene by id when it has no label', () => {
    const b = beatIn(
      '<div data-composition-id="main"><section data-va-beat="features" data-composition-id="features"><link rel="stylesheet" href="x.css"></section></div>',
      'features',
    )
    expect(scopedStyleProblems(b, 'features')).toEqual([
      `Scene "features" has a <link>; put its styles in the scene's one <style>.`,
    ])
  })

  it('refuses a prelude, two blocks, rules outside and broken CSS', () => {
    expect(one('@scope ([data-va-beat="intro"]) { .card {} }')).toMatch(/write @scope with nothing after it/)
    expect(one('@scope ([data-va-beat="features"]) { .card {} }')).toMatch(
      /write @scope with nothing after it/,
    )
    expect(one('@scope { .a {} } @scope { .b {} }')).toMatch(/2 @scope blocks/)
    expect(one('.card { color: red }')).toMatch(/must hold one @scope/)
    expect(one('@scope { .card { color: red } } body { color: red }')).toMatch(/rules outside @scope/)
    expect(one('@scope { .card { color: red } ! }')).toMatch(/isn't valid CSS/)
  })

  it('accepts the prelude naming this scene only as the B1 fallback', () => {
    const b = scene('<style>@scope ([data-va-beat="features"]) { .card {} }</style>')
    expect(scopedStyleProblems(b, 'features', { allowPrelude: true })).toEqual([])
    const other = scene('<style>@scope ([data-va-beat="intro"]) { .card {} }</style>')
    expect(scopedStyleProblems(other, 'features', { allowPrelude: true })).toHaveLength(1)
    const limited = scene('<style>@scope ([data-va-beat="features"]) to (.x) { .card {} }</style>')
    expect(scopedStyleProblems(limited, 'features', { allowPrelude: true })).toHaveLength(1)
  })

  it('refuses at-rules outside the allow-list by name', () => {
    for (const [css, at] of [
      ['@import url(assets/x.css);', 'import'],
      ['@font-face { font-family: X; src: url(assets/x.woff2) }', 'font-face'],
      ['@property --x { syntax: "<length>"; inherits: false; initial-value: 0px }', 'property'],
      ['@counter-style x { system: cyclic; symbols: "*" }', 'counter-style'],
      ['@page { margin: 0 }', 'page'],
      ['@layer base { .card { color: red } }', 'layer'],
      ['@namespace svg url(http://www.w3.org/2000/svg);', 'namespace'],
      ['@position-try --x { top: 0 }', 'position-try'],
      ['@scope (.card) { .x {} }', 'scope'],
    ] as const)
      expect(styled(`@scope { ${css} .card {} }`)).toContain(
        `Scene "Features": its <style> uses @${at}, which isn't allowed in a scene (only @media, @supports, @container and @keyframes).`,
      )
    expect(one('@scope { @container card (min-width: 1px) { .card {} } }')).toMatch(/names a container/)
  })

  it('refuses global selectors and selectors that reach outside the scene', () => {
    expect(one('@scope { :root { color: red } }')).toMatch(/selects :root/)
    expect(one('@scope { html .card { color: red } }')).toMatch(/selects html/)
    expect(one('@scope { body { color: red } }')).toMatch(/selects body/)
    expect(one('@scope { :r\\oot { color: red } }')).toMatch(/selects :root/)
    expect(one('@scope { .x :scope { color: red } }')).toMatch(/from outside it/)
    expect(one('@scope { :scope + .x { color: red } }')).toMatch(/siblings/)
    expect(one('@scope { :scope ~ .x { color: red } }')).toMatch(/siblings/)
    expect(one('@scope { :scope:has(~ .x) { color: red } }')).toMatch(/siblings/)
  })

  it('refuses urls that are not plain relative paths under assets/', () => {
    for (const u of [
      'https://x.test/a.png',
      '//x.test/a.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      '../x.png',
      'assets/../x.png',
      '/abs.png',
      'other/x.png',
    ])
      expect(one(`@scope { .card { background: url("${u}") } }`)).toMatch(/its <style> loads/)
    expect(one('@scope { .card { background-image: image-set("https://x.test/a.png" 1x) } }')).toMatch(
      /loads a https: URL/,
    )
  })

  it('refuses unprefixed keyframes', () => {
    expect(one('@scope { @keyframes pulse { from { opacity: 0 } } }')).toBe(
      'Scene "Features": its @keyframes pulse must be named "features-…" (keyframe names are shared by the whole video).',
    )
    expect(
      one('@scope { @media (min-width: 1px) { @keyframes intro-pulse { from { opacity: 0 } } } }'),
    ).toMatch(/intro-pulse/)
  })

  it('refuses colour role declarations in the style or a style attribute', () => {
    expect(one('@scope { .card { --va-color-accent: red } }')).toBe(
      `Scene "Features": its <style> declares --va-color-accent; use the root's colour roles.`,
    )
    expect(scopedStyleProblems(scene('<div style="--va-color-accent: red"></div>'), 'features')).toEqual([
      `Scene "Features" declares --va-color-accent in a style attribute; use the root's colour roles.`,
    ])
    expect(
      scopedStyleProblems(scene('<div style="--va-c\\olor-accent: red"></div>'), 'features'),
    ).toHaveLength(1)
  })

  it('refuses a second <style>, <svg><style>, <link> and data-composition-src', () => {
    const ok = '<style>@scope { .card {} }</style>'
    expect(scopedStyleProblems(scene(`${ok}<style>@scope { .x {} }</style>`), 'features')).toEqual([
      'Scene "Features" has 2 <style> elements; use one.',
    ])
    expect(scopedStyleProblems(scene(`${ok}<svg><style>.x { fill: red }</style></svg>`), 'features')).toEqual(
      [`Scene "Features" has a <style> inside <svg>; put its rules in the scene's one <style>.`],
    )
    expect(
      scopedStyleProblems(scene(`${ok}<link rel="stylesheet" href="assets/x.css">`), 'features'),
    ).toEqual([`Scene "Features" has a <link>; put its styles in the scene's one <style>.`])
    expect(
      scopedStyleProblems(scene(`${ok}<div data-composition-src="other.html"></div>`), 'features'),
    ).toEqual([
      'Scene "Features" loads another composition (data-composition-src); build it inside the scene instead.',
    ])
  })
})
