// SVG allowlist sanitizer (plan v2 §9, §14 rule 26). Uploaded SVGs keep their original (served only as a download)
// and a clean copy, which is the only one runs and previews use. Bounded and inert: parse5 builds the tree without
// running anything, XML entities are never expanded, and only allowlisted elements and attributes survive.
import { parseFragment, serializeOuter, type DefaultTreeAdapterMap } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type ChildNode = DefaultTreeAdapterMap['childNode']

export const SVG_MAX_BYTES = 1024 * 1024
const MAX_ELEMENTS = 20_000
const MAX_DEPTH = 64

export class SvgError extends Error {}

const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
  'filter',
  'fegaussianblur',
  'feoffset',
  'feblend',
  'fecolormatrix',
  'fecomposite',
  'feflood',
  'femerge',
  'femergenode',
  'femorphology',
  'fedropshadow',
  'image',
  'marker',
  'switch',
])

const ATTRS = new Set([
  'id',
  'class',
  'viewbox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'opacity',
  'clip-path',
  'clip-rule',
  'mask',
  'filter',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'fx',
  'fy',
  'patternunits',
  'patterncontentunits',
  'patterntransform',
  'preserveaspectratio',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'dx',
  'dy',
  'rotate',
  'textlength',
  'lengthadjust',
  'visibility',
  'display',
  'color',
  'stddeviation',
  'in',
  'in2',
  'result',
  'mode',
  'values',
  'type',
  'operator',
  'k1',
  'k2',
  'k3',
  'k4',
  'flood-color',
  'flood-opacity',
  'radius',
  'markerwidth',
  'markerheight',
  'refx',
  'refy',
  'orient',
  'markerunits',
  'xmlns',
  'xmlns:xlink',
  'version',
  'href',
  'xlink:href',
  'style',
  'clippathunits',
  'maskunits',
  'maskcontentunits',
  'filterunits',
  'primitiveunits',
  'paint-order',
  'vector-effect',
  'shape-rendering',
  'image-rendering',
  'text-rendering',
  'mix-blend-mode',
  'isolation',
  'startoffset',
  'method',
  'spacing',
])

/** Only references inside the document (#id) may be followed. */
const internalRef = (v: string) => /^#[A-Za-z_][\w.:-]*$/.test(v.trim())
/** Paint and filter values may point at an internal id, never a URL. */
const safeValue = (v: string) => {
  const urls = [...v.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].map((m) => m[2] ?? '')
  return urls.every(internalRef) && !/@import|expression\s*\(|javascript:|-moz-binding|behavior\s*:/i.test(v)
}

function clean(el: Element, depth: number, count: { n: number }) {
  if (depth > MAX_DEPTH) throw new SvgError('The SVG is nested too deeply.')
  el.attrs = el.attrs.filter((a) => {
    const name = (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase()
    if (!ATTRS.has(name)) return false
    if (name === 'href' || name === 'xlink:href') return internalRef(a.value)
    return safeValue(a.value)
  })
  el.childNodes = el.childNodes.filter((c) => {
    if (c.nodeName === '#text') return true
    if (!('tagName' in c)) return false // comments, processing instructions, doctypes
    if (++count.n > MAX_ELEMENTS) throw new SvgError('The SVG has too many elements.')
    if (!ELEMENTS.has(c.tagName.toLowerCase())) return false
    clean(c, depth + 1, count)
    return true
  })
  // <image> may only show something inside the file: with no internal href left, drop it.
  if (
    el.tagName.toLowerCase() === 'image' &&
    !el.attrs.some((a) => a.name === 'href' || a.name === 'xlink:href')
  )
    el.childNodes = []
}

/** The sanitized copy of an SVG, or SvgError when it isn't one or is too big. */
export function sanitizeSvg(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > SVG_MAX_BYTES) throw new SvgError('SVGs must be 1 MB or smaller.')
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  // XML declarations, doctypes (and their entities) and comments before the root are dropped, never expanded.
  const start = text.search(/<svg[\s>]/i)
  if (start < 0) throw new SvgError("This isn't an SVG image.")
  const frag = parseFragment(text.slice(start))
  const svg = frag.childNodes.find((c): c is Element => 'tagName' in c && c.tagName.toLowerCase() === 'svg')
  if (!svg) throw new SvgError("This isn't an SVG image.")
  clean(svg, 0, { n: 0 })
  if (!svg.attrs.some((a) => a.name === 'xmlns'))
    svg.attrs.push({ name: 'xmlns', value: 'http://www.w3.org/2000/svg' })
  return new TextEncoder().encode(serializeOuter(svg as unknown as ChildNode & Node))
}
