// Scripts in a scoped beat (redo a scene, plan §4.6): no escapes to parents, siblings or globals, no GSAP selector
// strings. Frozen beats and validate() are untouched.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { attr, load, validate, walk } from './contract.js'
import { scopedScriptProblems } from './scope-script.js'

const music = readFileSync(new URL('../../test/fixtures/contract1-music/index.html', import.meta.url), 'utf8')
const fixture = readFileSync(
  new URL('../../test/fixtures/scope/styles/scoped-demo.html', import.meta.url),
  'utf8',
)

const beatIn = (html: string, id: string) => {
  const b = [...walk(load(html).root)].find((e) => attr(e, 'data-va-beat') === id)
  if (!b) throw new Error(`no beat ${id}`)
  return b
}
const scene = (body: string, inner = '') =>
  beatIn(
    `<div data-composition-id="main"><section data-va-beat="features" data-va-label="Features" data-composition-id="features">${inner}<script>vaBeat('features', (tl, el) => { ${body} })</script></section></div>`,
    'features',
  )
const problems = (body: string) => scopedScriptProblems(scene(body), 'features')

describe('scoped beat scripts', () => {
  it('reports each escape, naming the scene', () => {
    for (const [code, what] of [
      ['el.parentElement.remove()', 'parentElement'],
      ['el.parentNode.style.x = 1', 'parentNode'],
      ["el.closest('#root').remove()", 'closest(…)'],
      ['el.ownerDocument.body.remove()', 'ownerDocument'],
      ['el.getRootNode().body', 'getRootNode()'],
      ['el.nextElementSibling.remove()', 'nextElementSibling'],
      ['el.previousElementSibling.remove()', 'previousElementSibling'],
      ['globalThis.x = 1', 'globalThis'],
      ['self.x = 1', 'self'],
      ['window.x = 1', 'window'],
      ["eval('1')", 'eval'],
      ["new Function('return 1')()", 'Function(…)'],
    ] as const)
      expect(problems(code)).toEqual([
        `Scene "Features"'s script uses ${what}: it may only reach inside its own element (el).`,
      ])
  })

  it('reports GSAP selector strings', () => {
    for (const [code, call] of [
      ["tl.from('.card', { opacity: 0 })", 'tl.from'],
      ['tl.to(".x", { x: 1 })', 'tl.to'],
      ['tl.fromTo(`.x`, { x: 0 }, { x: 1 })', 'tl.fromTo'],
      ["tl.set('.x', { x: 1 })", 'tl.set'],
      ["gsap.to('.x', { x: 1 })", 'gsap.to'],
      ["gsap.timeline('x')", 'gsap.timeline'],
    ] as const)
      expect(problems(code)).toEqual([
        `Scene "Features"'s script uses a selector string in ${call}(…): select with el.querySelector(All) and pass elements.`,
      ])
    expect(problems("gsap.utils.toArray('.card')")).toEqual([
      `Scene "Features"'s script uses a selector string in gsap.utils.toArray(…): select with el.querySelectorAll and pass elements.`,
    ])
  })

  it("follows the timeline's name when the agent renames it", () => {
    const b = beatIn(
      `<div data-composition-id="main"><section data-va-beat="features" data-va-label="Features" data-composition-id="features"><script>vaBeat('features', function (t, root) { t.from('.x', { opacity: 0 }) })</script></section></div>`,
      'features',
    )
    expect(scopedScriptProblems(b, 'features')).toEqual([
      `Scene "Features"'s script uses a selector string in t.from(…): select with el.querySelector(All) and pass elements.`,
    ])
  })

  it('accepts honest code', () => {
    expect(problems("tl.to(el.querySelector('.card'), { top: 10 })")).toEqual([])
    expect(
      problems("const cards = gsap.utils.toArray(el.querySelectorAll('.card')); tl.from(cards, { y: 8 })"),
    ).toEqual([])
    expect(
      problems('const parentCard = el.firstElementChild; const topBar = parentCard; tl.to(topBar, { x: 1 })'),
    ).toEqual([])
    expect(problems('// the parent frame cuts here\ntl.set(el, { opacity: 1 })')).toEqual([])
    // New nodes for el, the way the skill says since `document.` is refused (docs/spikes.md K1).
    expect(
      problems(
        "const s = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg'); el.append(s, el.ownerDocument.createTextNode('x'), el.ownerDocument.createElement('span'))",
      ),
    ).toEqual([])
    // Anything else through ownerDocument still reaches outside.
    expect(problems("el.ownerDocument.createElement('i'); el.ownerDocument.body.remove()")).toEqual([
      `Scene "Features"'s script uses ownerDocument: it may only reach inside its own element (el).`,
    ])
    expect(scopedScriptProblems(beatIn(fixture, 'demo'), 'demo')).toEqual([])
  })

  it('checks every script in the scene, script files and inline handlers', () => {
    const b = scene(
      'tl.set(el, {})',
      '<div><script>window.x = 1</script></div><script src="assets/x.js"></script><img onload="x()">',
    )
    expect(scopedScriptProblems(b, 'features')).toEqual([
      // In document order.
      `Scene "Features"'s script uses window: it may only reach inside its own element (el).`,
      `Scene "Features" loads a script file; write its code in the scene's vaBeat script.`,
      `Scene "Features" has an inline onload handler; put the code in the scene's vaBeat script.`,
    ])
  })

  it('leaves frozen beats and validate() alone', () => {
    const escaping = music.replace(
      'tl.from(el.querySelector(\'[data-va-text="outro-cta"]\')',
      'tl.from(el.parentElement.querySelector(".title")',
    )
    expect(escaping).not.toBe(music)
    // validate's rules for every beat are unchanged: the escape isn't one of them.
    expect(validate(escaping)).toEqual(validate(music))
    // Only the beats passed in are checked: redoing "demo" doesn't look at "outro".
    expect(scopedScriptProblems(beatIn(escaping, 'demo'), 'demo')).toEqual([])
    expect(scopedScriptProblems(beatIn(escaping, 'outro'), 'outro')).toEqual([
      `Scene "outro"'s script uses parentElement: it may only reach inside its own element (el).`,
    ])
  })
})
