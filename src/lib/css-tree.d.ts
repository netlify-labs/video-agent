// The slice of css-tree 3.x that src/lib/scope-style.ts uses (the package ships no types). Node shapes follow
// css-tree's AST (docs/ast.md); only the fields read here are declared.
declare module 'css-tree' {
  export interface CssNode {
    type: string
    name?: string
    property?: string
    value?: unknown
    prelude?: CssNode | null
    block?: CssNode | null
    children?: CssList | null
  }
  export interface CssList {
    toArray(): CssNode[]
    readonly size: number
  }
  export interface ParseOptions {
    context?: 'stylesheet' | 'declarationList' | 'value'
    onParseError?: (error: { message: string }) => void
    parseAtrulePrelude?: boolean
    parseRulePrelude?: boolean
    parseValue?: boolean
  }
  export function parse(text: string, options?: ParseOptions): CssNode
  export interface WalkContext {
    /** The innermost at-rule around the node, or null at the top level. */
    atrule: CssNode | null
  }
  export function walk(ast: CssNode, enter: (this: WalkContext, node: CssNode) => void): void
  export const ident: { decode(s: string): string }
}
