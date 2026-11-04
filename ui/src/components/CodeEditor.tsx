// A code editor (CodeMirror 6): line numbers, real indentation (Tab indents), bracket matching and JavaScript /
// TypeScript highlighting, in the app's light or dark theme. Controlled loosely: it keeps its own text while focused
// and takes `value` again when it changes from outside (a revert) while unfocused.
import { useComputedColorScheme } from '@mantine/core'
import { javascript } from '@codemirror/lang-javascript'
import { Compartment, EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup, EditorView } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'

export interface CodeEditorHandle {
  focus: () => void
  /** Selects line `i` (from 0) and scrolls it into view. */
  selectLine: (i: number) => void
}

export function CodeEditor({
  value,
  onChange,
  label,
  height,
  onHandle,
}: {
  value: string
  onChange: (value: string) => void
  /** The accessible name of the text box. */
  label: string
  /** A fixed height (CSS); otherwise it grows with the code. */
  height?: string
  onHandle?: (h: CodeEditorHandle | null) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const changed = useRef(onChange)
  changed.current = onChange
  const theme = useRef(new Compartment())
  const dark = useComputedColorScheme('dark') === 'dark'

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          javascript({ typescript: true, jsx: true }),
          theme.current.of(dark ? oneDark : []),
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
          EditorView.theme({
            '&': { height: height ?? 'auto', fontSize: '12.5px' },
            '.cm-scroller': { fontFamily: 'var(--mantine-font-family-monospace)', lineHeight: '1.6' },
            '&.cm-focused': { outline: 'none' },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changed.current(u.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = v
    onHandle?.({
      focus: () => {
        v.focus()
      },
      selectLine: (i) => {
        const line = v.state.doc.line(Math.min(Math.max(i + 1, 1), v.state.doc.lines))
        v.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true })
        v.dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
        v.focus()
      },
    })
    return () => {
      onHandle?.(null)
      v.destroy()
      view.current = null
    }
    // Made once; value, theme and label follow below.
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(dark ? oneDark : []) })
  }, [dark])

  // A change from outside (Revert, the other editor in the expanded view) while this one isn't being typed in.
  useEffect(() => {
    const v = view.current
    if (!v || v.hasFocus) return
    const doc = v.state.doc.toString()
    if (doc !== value) v.dispatch({ changes: { from: 0, to: doc.length, insert: value } })
  }, [value])

  return <div ref={host} className="va-code-editor" />
}
