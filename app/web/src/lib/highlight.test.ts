import { describe, expect, it } from 'vitest'
import { tokenize, type CodeLang } from './highlight'

const join = (code: string, lang: CodeLang) =>
  tokenize(code, lang)
    .map((t) => t.text)
    .join('')
const cls = (code: string, lang: CodeLang, text: string) =>
  tokenize(code, lang).find((t) => t.text === text)?.cls

describe('tokenize', () => {
  const json = `{
  "id": "dst_…", "n": 3,   // a comment
  "target": null, "files": [ { "kind": "poster", … } ]
}`
  const http = `POST {callback.url}
Authorization: Bearer {callback.token}

{ "status": "live" }`
  const ts = `export function f(a: string): number {\n  return a.length // len\n}\n`

  it('keeps every character', () => {
    expect(join(json, 'json')).toBe(json)
    expect(join(http, 'http')).toBe(http)
    expect(join(ts, 'ts')).toBe(ts)
    expect(join('const x = `${1}`', 'js')).toBe('const x = `${1}`')
  })

  it('tells keys from values in json', () => {
    expect(cls(json, 'json', '"id"')).toBe('hl-key')
    expect(cls(json, 'json', '"dst_…"')).toBe('hl-string')
    expect(cls(json, 'json', '3')).toBe('hl-number')
    expect(cls(json, 'json', 'null')).toBe('hl-keyword')
    expect(cls(json, 'json', '// a comment')).toBe('hl-comment')
  })

  it('highlights http head and body', () => {
    expect(cls(http, 'http', 'POST')).toBe('hl-keyword')
    expect(cls(http, 'http', 'Authorization')).toBe('hl-key')
    expect(cls(http, 'http', '"status"')).toBe('hl-key')
    expect(cls(http, 'http', '"live"')).toBe('hl-string')
  })

  it('highlights ts', () => {
    expect(cls(ts, 'ts', 'function')).toBe('hl-keyword')
    expect(cls(ts, 'ts', 'string')).toBe('hl-type')
    expect(cls(ts, 'ts', '// len')).toBe('hl-comment')
  })
})
