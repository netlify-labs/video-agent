// Styles in a scoped beat (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.6). A scoped revision may restyle
// the scenes it redoes, never the rest: shared CSS (fonts, classes, --va-color-* roles) lives in <head> and the root's
// <style>, which are frozen. So a scoped beat gets at most one <style>, a direct child, holding one prelude-less
// @scope block (it scopes to the style's parent, the beat). The CSS is parsed with css-tree and walked; nothing here
// reads CSS with a regex. Only scoped beats are checked: frozen beats keep whatever the parent had.
import { ident, parse, walk as walkCss, type CssNode } from 'css-tree'
import type { DefaultTreeAdapterMap } from 'parse5'
import { attr, walk } from './contract.js'

type Element = DefaultTreeAdapterMap['element']

/** At-rules a scoped <style> may use inside its @scope. Everything else is refused by name (many are global). */
const ALLOWED_AT_RULES = new Set(['media', 'supports', 'container', 'keyframes'])
const GLOBAL_SELECTORS = new Set(['html', 'body'])
const COLOR_ROLE = /^--va-color-/i

export interface ScopedStyleOptions {
  /** Fallback if spike B1 finds the prelude-less form misbehaving: also accept `@scope ([data-va-beat="<id>"])`. */
  allowPrelude?: boolean
}

/** The name people see for a beat: its data-va-label, else its id. */
export const sceneName = (beat: Element, beatId: string) =>
  attr(beat, 'data-va-label')?.trim().slice(0, 80) || beatId

const textOf = (el: Element): string =>
  el.childNodes
    .map((n) => (n.nodeName === '#text' && 'value' in n ? n.value : isEl(n) ? textOf(n) : ''))
    .join('')
const isEl = (n: DefaultTreeAdapterMap['node']): n is Element => 'tagName' in n
const name = (s: string | undefined) => ident.decode(s ?? '').toLowerCase()
const items = (n: CssNode | null | undefined): CssNode[] => n?.children?.toArray() ?? []

/** Every way a scoped beat's styles or markup could reach outside it, in plain words; empty when it's fine. */
export function scopedStyleProblems(beat: Element, beatId: string, opts: ScopedStyleOptions = {}): string[] {
  const scene = `Scene "${sceneName(beat, beatId)}"`
  const p: string[] = []
  const els = [beat, ...walk(beat)]

  const own = beat.childNodes.filter(isEl).filter((e) => e.tagName === 'style')
  for (const e of els) {
    if (e.tagName === 'style' && !own.includes(e))
      p.push(
        `${scene} has a <style> inside <${e.parentNode && isEl(e.parentNode) ? e.parentNode.tagName : '?'}>; put its rules in the scene's one <style>.`,
      )
    if (e.tagName === 'link') p.push(`${scene} has a <link>; put its styles in the scene's one <style>.`)
    if (attr(e, 'data-composition-src') !== null)
      p.push(`${scene} loads another composition (data-composition-src); build it inside the scene instead.`)
    const inline = attr(e, 'style')
    if (inline !== null) {
      const decl = colorRoleIn(inline)
      if (decl) p.push(`${scene} declares ${decl} in a style attribute; use the root's colour roles.`)
    }
  }
  if (own.length > 1) p.push(`${scene} has ${own.length} <style> elements; use one.`)
  for (const s of own) p.push(...sheetProblems(textOf(s), scene, beatId, opts))
  return p
}

function colorRoleIn(inline: string): string | null {
  let found: string | null = null
  walkCss(parse(inline, { context: 'declarationList' }), function (n) {
    if (n.type === 'Declaration' && COLOR_ROLE.test(name(n.property)) && !found) found = name(n.property)
  })
  return found
}

function sheetProblems(css: string, scene: string, beatId: string, opts: ScopedStyleOptions): string[] {
  const p: string[] = []
  const errors: string[] = []
  const ast = parse(css, { onParseError: (e) => errors.push(e.message) })
  if (errors.length) return [`${scene}: its <style> isn't valid CSS: ${errors[0] ?? ''}.`]

  const top = items(ast)
  const scopes = top.filter((n) => n.type === 'Atrule' && name(n.name) === 'scope')
  if (scopes.length === 0) p.push(`${scene}: its <style> must hold one @scope { … } block.`)
  if (scopes.length > 1) p.push(`${scene}: its <style> has ${scopes.length} @scope blocks; use one.`)
  if (scopes.length && top.some((n) => !scopes.includes(n)))
    p.push(`${scene}: its <style> has rules outside @scope { … }; put every rule inside it.`)
  for (const s of scopes) {
    if (!s.prelude) continue
    if (!(opts.allowPrelude && preludeIsBeat(s.prelude, beatId)))
      p.push(`${scene}: write @scope with nothing after it (it then applies to this scene only).`)
  }

  const seen = new Set<string>()
  const add = (m: string) => {
    if (!seen.has(m)) p.push(m)
    seen.add(m)
  }
  for (const s of scopes)
    walkCss(s, function (n) {
      if (n === s) return
      switch (n.type) {
        case 'Atrule': {
          const at = name(n.name)
          if (!ALLOWED_AT_RULES.has(at))
            add(
              `${scene}: its <style> uses @${at}, which isn't allowed in a scene (only @media, @supports, @container and @keyframes).`,
            )
          else if (at === 'container' && items(n.prelude)[0]?.type === 'Identifier')
            add(
              `${scene}: its <style> names a container (@container ${name(items(n.prelude)[0]?.name)}); use an unnamed @container.`,
            )
          else if (at === 'keyframes') {
            const k = keyframesName(n)
            if (!k.startsWith(`${beatId}-`))
              add(
                `${scene}: its @keyframes ${k || '(unnamed)'} must be named "${beatId}-…" (keyframe names are shared by the whole video).`,
              )
          }
          break
        }
        case 'PseudoClassSelector':
          if (name(n.name) === 'root') add(`${scene}: its <style> selects :root; select inside the scene.`)
          break
        case 'TypeSelector':
          if (GLOBAL_SELECTORS.has(name(n.name)))
            add(`${scene}: its <style> selects ${name(n.name)}; select inside the scene.`)
          break
        case 'Selector': {
          const why = reachesOut(n)
          if (why) add(`${scene}: its <style> ${why}; select inside the scene.`)
          break
        }
        case 'Url': {
          const why = badUrl(typeof n.value === 'string' ? n.value : '')
          if (why) add(`${scene}: its <style> loads ${why}; use a file under assets/ (relative path).`)
          break
        }
        case 'Function':
          if (/image-set$/.test(name(n.name)))
            for (const c of items(n))
              if (c.type === 'String') {
                const why = badUrl(typeof c.value === 'string' ? c.value : '')
                if (why) add(`${scene}: its <style> loads ${why}; use a file under assets/ (relative path).`)
              }
          break
        case 'Declaration':
          if (COLOR_ROLE.test(name(n.property)))
            add(`${scene}: its <style> declares ${name(n.property)}; use the root's colour roles.`)
          break
      }
    })
  return p
}

/** `@scope ([data-va-beat="<id>"])` and nothing else (the fallback form). */
function preludeIsBeat(prelude: CssNode, beatId: string): boolean {
  const scope = items(prelude)
  if (scope.length !== 1 || scope[0]?.type !== 'Scope') return false
  const s = scope[0] as CssNode & { root?: CssNode | null; limit?: CssNode | null }
  if (s.limit) return false
  const sel = items(s.root)
  const parts = sel.length === 1 ? items(sel[0]) : []
  // An AttributeSelector's name and value are nodes, not strings.
  const a = parts[0] as unknown as
    { type: string; name?: { name?: string }; matcher?: string; value?: { value?: unknown } } | undefined
  return (
    parts.length === 1 &&
    a?.type === 'AttributeSelector' &&
    name(a.name?.name) === 'data-va-beat' &&
    a.matcher === '=' &&
    a.value?.value === beatId
  )
}

function keyframesName(n: CssNode): string {
  const first = items(n.prelude)[0]
  if (first?.type === 'Identifier') return ident.decode(first.name ?? '')
  if (first?.type === 'String' && typeof first.value === 'string') return first.value
  return ''
}

/**
 * Inside @scope, `:scope` and `&` are the beat. A selector reaches outside it when something comes before them
 * (`.x :scope` is an ancestor), when a sibling combinator follows them (`:scope + .x` is the next beat), or when a
 * :has() on them looks at siblings (`:scope:has(~ .x)`).
 */
function reachesOut(sel: CssNode): string | null {
  const parts = items(sel)
  const isScope = (n: CssNode | undefined) =>
    n?.type === 'NestingSelector' || (n?.type === 'PseudoClassSelector' && name(n.name) === 'scope')
  for (const [i, n] of parts.entries()) {
    if (!isScope(n)) continue
    if (parts.slice(0, i).some((x) => x.type === 'Combinator'))
      return 'selects the scene from outside it (something before :scope)'
    const next = parts.slice(i + 1).find((x) => x.type === 'Combinator')
    if (next && (next.name === '+' || next.name === '~'))
      return `selects the scene's siblings (:scope ${next.name ?? ''})`
    const end = parts.findIndex((x, j) => j > i && x.type === 'Combinator')
    for (const c of parts.slice(i, end < 0 ? parts.length : end))
      if (c.type === 'PseudoClassSelector' && name(c.name) === 'has' && hasSiblingArg(c))
        return "looks at the scene's siblings (:scope:has(+ … or ~ …))"
  }
  return null
}

function hasSiblingArg(has: CssNode): boolean {
  return items(has).some((list) =>
    items(list).some((s) => {
      const first = items(s)[0]
      return first?.type === 'Combinator' && (first.name === '+' || first.name === '~')
    }),
  )
}

/** Why a url() is refused, or null for a plain relative path under assets/. */
function badUrl(u: string): string | null {
  const v = u.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return `a ${v.split(':')[0]?.toLowerCase() ?? ''}: URL`
  if (v.startsWith('//')) return 'a file from another site'
  if (v.startsWith('/')) return `an absolute path (${v})`
  if (v.split(/[/\\]/).includes('..')) return `a path with .. (${v})`
  if (!v.startsWith('assets/')) return `${v || 'an empty url()'}, which isn't under assets/`
  return null
}
