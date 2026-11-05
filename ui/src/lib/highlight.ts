// Syntax highlighting for read-only docs code, as a flat list of tokens (CodeBlock renders them). It parses with the
// same Lezer grammars the editor uses, without an editor instance.
//
// lang "json" is JSON as the docs write it: with `// comments` and `…` placeholders, so it is parsed as a JavaScript
// expression, and a string followed by `:` is shown as a key. "http" is a request line, headers, a blank line and a
// JSON body.
import { javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript'
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight'

export type CodeLang = 'json' | 'js' | 'ts' | 'http'

export interface Token {
  text: string
  cls: string
}

const highlighter = tagHighlighter([
  { tag: [t.keyword, t.null, t.bool, t.self], class: 'hl-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], class: 'hl-string' },
  { tag: t.number, class: 'hl-number' },
  { tag: [t.lineComment, t.blockComment, t.comment], class: 'hl-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'hl-function' },
  { tag: [t.typeName, t.className, t.namespace], class: 'hl-type' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], class: 'hl-definition' },
  { tag: t.propertyName, class: 'hl-property' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], class: 'hl-punctuation' },
])

const NEWLINE: Token = { text: '\n', cls: '' }

function lex(code: string, lang: 'json' | 'js' | 'ts'): Token[] {
  const out: Token[] = []
  const put = (text: string, cls: string) => out.push({ text, cls })
  const br = () => out.push(NEWLINE)
  if (lang === 'json') {
    // Parsed as `(…)` so the top-level `{` is an object, not a block; only the original range is emitted.
    const src = `(${code})`
    highlightCode(src, javascriptLanguage.parser.parse(src), highlighter, put, br, 1, src.length - 1)
    markKeys(out)
  } else {
    const parser = (lang === 'ts' ? typescriptLanguage : javascriptLanguage).parser
    highlightCode(code, parser.parse(code), highlighter, put, br)
  }
  return out
}

/** A string token whose next non-blank token is `:` is an object key. */
function markKeys(tokens: Token[]) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.cls !== 'hl-string') continue
    let j = i + 1
    while (
      j < tokens.length &&
      tokens[j]?.cls === '' &&
      tokens[j]?.text.trim() === '' &&
      tokens[j] !== NEWLINE
    )
      j++
    const next = tokens[j]
    if (next?.text.startsWith(':')) tokens[i] = { text: tokens[i]?.text ?? '', cls: 'hl-key' }
  }
}

function lexHttp(code: string): Token[] {
  const blank = code.indexOf('\n\n')
  const head = blank === -1 ? code : code.slice(0, blank)
  const out: Token[] = []
  head.split('\n').forEach((line, i) => {
    if (i > 0) out.push(NEWLINE)
    if (i === 0) {
      const sp = line.indexOf(' ')
      if (sp === -1) out.push({ text: line, cls: 'hl-keyword' })
      else out.push({ text: line.slice(0, sp), cls: 'hl-keyword' }, { text: line.slice(sp), cls: 'hl-url' })
      return
    }
    const colon = line.indexOf(':')
    if (colon === -1) out.push({ text: line, cls: '' })
    else
      out.push(
        { text: line.slice(0, colon), cls: 'hl-key' },
        { text: ':', cls: 'hl-punctuation' },
        { text: line.slice(colon + 1), cls: 'hl-string' },
      )
  })
  if (blank !== -1) out.push(NEWLINE, NEWLINE, ...lex(code.slice(blank + 2), 'json'))
  return out
}

/** The code as tokens; their texts joined are exactly `code`. `cls` is an hl-* class, or '' for plain text. */
export function tokenize(code: string, lang: CodeLang): Token[] {
  return lang === 'http' ? lexHttp(code) : lex(code, lang)
}
