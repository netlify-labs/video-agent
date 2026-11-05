// Scripts in a scoped beat (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.6). validate() already refuses
// `document.` and `window.__timelines` in every beat's script; a scene that's redone while the others are frozen also
// may not reach its parents or siblings, the global object, or code built from strings, and may not hand GSAP a
// selector string (GSAP resolves strings against the whole document, not the beat). This is a heuristic: a
// determined script can still reach outside its beat. The only check on pixels is the live test's SSIM over the frozen
// scenes (scripts/e2e/regen-beat.ts). Only scoped beats are checked, so existing videos stay editable.
import type { DefaultTreeAdapterMap } from 'parse5'
import { attr, walk } from './contract.js'
import { sceneName } from './scope-style.js'

type Element = DefaultTreeAdapterMap['element']

/** Ways out of the beat, with the words people see. */
const ESCAPES: [RegExp, string][] = [
  [/\bparentNode\b/, 'parentNode'],
  [/\bparentElement\b/, 'parentElement'],
  [/\bownerDocument\b/, 'ownerDocument'],
  [/\bgetRootNode\b/, 'getRootNode()'],
  [/\bclosest\s*\(/, 'closest(…)'],
  [/\bpreviousElementSibling\b/, 'previousElementSibling'],
  [/\bnextElementSibling\b/, 'nextElementSibling'],
  [/\bglobalThis\b/, 'globalThis'],
  [/\bself\s*\./, 'self'],
  [/\bwindow\b/, 'window'],
  [/\beval\b/, 'eval'],
  [/\bFunction\s*\(/, 'Function(…)'],
]
const GSAP_METHODS = 'from|to|fromTo|set|timeline'

/** Every way a scoped beat's scripts could reach outside it, in plain words; empty when they're fine. */
export function scopedScriptProblems(beat: Element, beatId: string): string[] {
  const scene = `Scene "${sceneName(beat, beatId)}"`
  const p: string[] = []
  const add = (m: string) => {
    if (!p.includes(m)) p.push(m)
  }
  for (const e of [beat, ...walk(beat)]) {
    for (const a of e.attrs)
      if (/^on/i.test(a.name))
        add(`${scene} has an inline ${a.name} handler; put the code in the scene's vaBeat script.`)
    if (e.tagName !== 'script') continue
    const code = e.childNodes.map((n) => (n.nodeName === '#text' && 'value' in n ? n.value : '')).join('')
    if (attr(e, 'src') !== null)
      add(`${scene} loads a script file; write its code in the scene's vaBeat script.`)
    for (const [re, what] of ESCAPES)
      if (re.test(code)) add(`${scene}'s script uses ${what}: it may only reach inside its own element (el).`)
    // The timeline is vaBeat's first callback parameter, whatever the agent named it.
    const tl = /vaBeat\(\s*['"][^'"]*['"]\s*,\s*(?:async\s*)?(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)/.exec(
      code,
    )?.[1]
    const owners = ['tl', 'gsap', ...(tl && tl !== 'tl' ? [tl.replace(/\$/g, '\\$')] : [])].join('|')
    const call = new RegExp(`\\b(${owners})\\s*\\.\\s*(${GSAP_METHODS})\\s*\\(\\s*['"\`]`).exec(code)
    if (call)
      add(
        `${scene}'s script uses a selector string in ${call[1] ?? ''}.${call[2] ?? ''}(…): select with el.querySelector(All) and pass elements.`,
      )
    if (/\bgsap\s*\.\s*utils\s*\.\s*toArray\s*\(\s*['"`]/.test(code))
      add(
        `${scene}'s script uses a selector string in gsap.utils.toArray(…): select with el.querySelectorAll and pass elements.`,
      )
  }
  return p
}
