// A read-only code block with syntax highlighting, for docs: tokens from lib/highlight, colours from code-block.css in
// the light or dark theme.
import { Code } from '@mantine/core'
import { useMemo } from 'react'
import { tokenize, type CodeLang } from '../lib/highlight'
import './code-block.css'

export function CodeBlock({ code, lang, fontSize }: { code: string; lang: CodeLang; fontSize?: number }) {
  const tokens = useMemo(() => tokenize(code, lang), [code, lang])
  return (
    <Code block className="va-code" style={{ whiteSpace: 'pre', overflowX: 'auto', fontSize }}>
      {tokens.map((tok, i) =>
        tok.cls ? (
          <span key={i} className={tok.cls}>
            {tok.text}
          </span>
        ) : (
          tok.text
        ),
      )}
    </Code>
  )
}
