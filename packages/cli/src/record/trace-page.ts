// The page side of `video-agent record`'s pointer trace (screen-recording plan §4.6; va-rsk5.5.2): an init script that
// listens in the capture phase and sends batches to the recorder through a binding. Times are epoch milliseconds
// (performance.timeOrigin + now(), the screencast's clock); positions are CSS pixels with the viewport size. Keys are
// counted, never recorded. Hidden areas: elements matching the selectors are sampled at 10 Hz; with --privacy or
// --hide-text, the page's text is matched (app/server/lib/privacy-patterns.ts, the same code as the runner's OCR side) about
// three times a second and each match's own rectangle is sampled, off again once it's gone.
import { matchText } from '../../../../app/server/lib/privacy-patterns.js'

export interface PageEvent {
  /** move [t, x, y]; down/click/focus/key/wheel/hide per their fields. */
  k: 'move' | 'click' | 'focus' | 'key' | 'wheel' | 'hide'
  t: number
  x?: number
  y?: number
  dy?: number
  /** Element box [x, y, w, h] in CSS px. */
  box?: [number, number, number, number]
  role?: string
  name?: string
  /** hide: which element or text match (stable within its document), and whether it's on screen. */
  id?: number | string
  /** hide from text matching: what it is (email, key, …, string for a hide string). */
  kind?: string
  /** The document it came from (hidden-element ids are per document). */
  doc: string
  on?: boolean
  vw: number
  vh: number
}

export const TRACE_BINDING = '__vaTraceEmit'

/** The init script, as a string Playwright adds to every page. */
export function traceScript(opts: {
  hide: string[]
  names: boolean
  /** Text to find and hide: the patterns as [kind, source, flags] (privacy mode) and hide strings. */
  match?: { patterns: readonly (readonly [string, string, string])[]; strings: readonly string[] } | null
}): string {
  return `(() => {
  if (window.__vaTraceInstalled) return
  window.__vaTraceInstalled = true
  const HIDE = ${JSON.stringify(opts.hide)}
  const MATCH = ${JSON.stringify(opts.match ?? null)}
  // The matcher's own source (a bundler may wrap functions with __name: a no-op here).
  const __name = (f) => f
  const matchText = ${String(matchText)}
  const NAMES = ${JSON.stringify(opts.names)}
  const now = () => performance.timeOrigin + performance.now()
  let batch = []
  // A token per document: a same-document navigation (a #hash link) keeps it, a new page gets a new one.
  const DOC = String(performance.timeOrigin)
  const push = (e) => { e.vw = innerWidth; e.vh = innerHeight; e.doc = DOC; batch.push(e) }
  const flush = () => {
    if (!batch.length || typeof window.${TRACE_BINDING} !== 'function') return
    const b = batch
    batch = []
    window.${TRACE_BINDING}(b).catch(() => {})
  }
  setInterval(flush, 200)
  addEventListener('pagehide', flush, { capture: true })
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] }
  const IMPLICIT = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', IMG: 'img' }
  const roleOf = (el) => {
    const r = el.getAttribute && el.getAttribute('role')
    if (r) return r.split(' ')[0]
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      return t === 'checkbox' || t === 'radio' ? t : t === 'submit' || t === 'button' || t === 'reset' ? 'button' : 'textbox'
    }
    if (el.tagName === 'A' && !el.hasAttribute('href')) return 'generic'
    return IMPLICIT[el.tagName] || 'generic'
  }
  const nameOf = (el) => {
    if (!NAMES) return ''
    const label = el.getAttribute('aria-label')
    if (label) return label
    const by = el.getAttribute('aria-labelledby')
    if (by) return by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ')
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const l = el.labels && el.labels[0]
      if (l) return l.innerText
      // A button's value is its name; a text field's value is what someone typed, never a name.
      if (/^(submit|button|reset)$/i.test(el.getAttribute('type') || '')) return el.value || ''
      return el.getAttribute('placeholder') || el.getAttribute('title') || ''
    }
    return el.innerText || el.getAttribute('title') || el.getAttribute('alt') || ''
  }
  const INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role],[tabindex]'
  let lastMove = 0
  addEventListener('pointermove', (e) => {
    const t = now()
    if (t - lastMove < 1000 / 60) return
    lastMove = t
    push({ k: 'move', t, x: e.clientX, y: e.clientY })
  }, { capture: true, passive: true })
  addEventListener('click', (e) => {
    const el = (e.target && e.target.closest && e.target.closest(INTERACTIVE)) || e.target
    const name = el && el.nodeType === 1 ? String(nameOf(el)).replace(/\\s+/g, ' ').trim().slice(0, 200) : ''
    push({ k: 'click', t: now(), x: e.clientX, y: e.clientY, ...(el && el.nodeType === 1 ? { box: box(el), role: roleOf(el), name } : {}) })
  }, { capture: true })
  addEventListener('keydown', (e) => {
    const el = document.activeElement
    if (e.repeat || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
    push({ k: 'key', t: now(), ...(el && el !== document.body ? { box: box(el) } : {}) })
  }, { capture: true })
  addEventListener('wheel', (e) => push({ k: 'wheel', t: now(), dy: e.deltaY }), { capture: true, passive: true })
  addEventListener('focusin', (e) => {
    const el = e.target
    if (el && el.nodeType === 1) push({ k: 'focus', t: now(), box: box(el), role: roleOf(el) })
  }, { capture: true })
  // Hidden areas: every element matching a selector, sampled at 10 Hz; the recorder keeps a key when it moves.
  const ids = new WeakMap()
  let nextId = 1
  setInterval(() => {
    if (!HIDE.length) return
    const t = now()
    for (const sel of HIDE) {
      let els = []
      try { els = document.querySelectorAll(sel) } catch (err) { continue }
      for (const el of els) {
        if (!ids.has(el)) ids.set(el, nextId++)
        const b = box(el)
        const on = b[2] > 0 && b[3] > 0 && b[0] < innerWidth && b[1] < innerHeight && b[0] + b[2] > 0 && b[1] + b[3] > 0
        push({ k: 'hide', t, id: ids.get(el), box: b, on, role: roleOf(el) })
      }
    }
  }, 100)
  // Text matches: each match's rectangle (the union of its line boxes), keyed by its text node, kind and text, so a
  // scroll moves the same box; one gone since the last pass is sent once more, off.
  const textIds = new WeakMap()
  let nextText = 1
  let shown = new Map()
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 }
  if (MATCH) setInterval(() => {
    if (!document.body) return
    const t = now()
    const seen = new Map()
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && !SKIP[n.parentElement.tagName] && n.nodeValue && n.nodeValue.trim().length > 1 ? 1 : 3),
    })
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const found = matchText(n.nodeValue, MATCH.patterns, MATCH.strings)
      if (!found.length) continue
      if (!textIds.has(n)) textIds.set(n, nextText++)
      for (const m of found) {
        const r = document.createRange()
        r.setStart(n, m.start)
        r.setEnd(n, m.end)
        const rects = [...r.getClientRects()].filter((q) => q.width > 0 && q.height > 0)
        if (!rects.length) continue
        const x0 = Math.min(...rects.map((q) => q.left)), y0 = Math.min(...rects.map((q) => q.top))
        const x1 = Math.max(...rects.map((q) => q.right)), y1 = Math.max(...rects.map((q) => q.bottom))
        const b = [x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4]
        const on = b[0] < innerWidth && b[1] < innerHeight && b[0] + b[2] > 0 && b[1] + b[3] > 0
        const id = 'm' + textIds.get(n) + ':' + m.kind + ':' + m.text.length + ':' + m.start
        seen.set(id, m.kind)
        push({ k: 'hide', t, id, box: b, on, kind: m.kind })
      }
    }
    for (const [id, kind] of shown) if (!seen.has(id)) push({ k: 'hide', t, id, box: [0, 0, 0, 0], on: false, kind })
    shown = seen
  }, 300)
})()`
}
