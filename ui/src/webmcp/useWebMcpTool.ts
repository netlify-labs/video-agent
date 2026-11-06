// Registers a WebMCP tool while the component that offers it is mounted, so each page exposes only the tools that make
// sense on it. Feature-detected (document.modelContext), and off when an admin turns WebMCP off (the 'webmcp' feature).
// Registration happens once per mount: execute always calls the latest `run`, so it sees the page's current state.
import { useEffect, useRef } from 'react'
import { $api } from '../api/client'
import { confirmAction, type ConfirmRequest } from './confirm'
import {
  fail,
  inputProblems,
  invalidInput,
  isToolName,
  type InputSchema,
  type ToolFailure,
  type ToolResult,
} from './tools'

interface Base<I> {
  name: string
  title: string
  description: string
  input: InputSchema
  /** Checks the schema can't express (a look that exists, a scene on the page); run before any confirm. */
  check?: (input: I) => ToolFailure | null
  /** The work, with an input that fits `input`. */
  run: (input: I, signal: AbortSignal) => Promise<ToolResult | ToolFailure> | ToolResult | ToolFailure
}
/** A tool that only reads; untrusted when what it returns holds people's own words (prompts, titles, comments). */
interface ReadTool<I> extends Base<I> {
  kind: 'read'
  untrusted?: boolean
}
/** A tool that changes what's on screen or saves something cheap (a draft, a comment) without spending credits. */
interface ActTool<I> extends Base<I> {
  kind: 'act'
  untrusted?: boolean
}
/** Spends credits, publishes or deletes: the person confirms in the app before it runs. */
interface ConsequentialTool<I> extends Base<I> {
  kind: 'consequential'
  confirm: (input: I) => ConfirmRequest
}
export type WebMcpTool<I> = ReadTool<I> | ActTool<I> | ConsequentialTool<I>

/** WebMCP is offered: the browser has it and this deployment hasn't turned it off. */
export function useWebMcpAvailable(): boolean {
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  return (
    typeof document !== 'undefined' &&
    document.modelContext !== undefined &&
    config.data?.features.includes('webmcp') === true
  )
}

/** What the tool runs when an agent calls it: check the input, ask the person if it's consequential, then run. */
export async function executeTool<I>(tool: WebMcpTool<I>, input: unknown, signal: AbortSignal) {
  const problems = inputProblems(tool.input, input ?? {})
  if (problems.length) return invalidInput(problems)
  const valid = (input ?? {}) as I
  const refused = tool.check?.(valid)
  if (refused) return refused
  if (tool.kind === 'consequential') {
    const yes = await confirmAction(tool.confirm(valid), signal)
    if (!yes)
      return fail(
        'declined',
        'The person did not allow this in the app.',
        'Ask them whether they want it, then call the tool again.',
      )
  }
  try {
    return await tool.run(valid, signal)
  } catch (e) {
    return fail(
      'failed',
      e instanceof Error ? e.message : String(e),
      'Check the page in the browser, then try again.',
    )
  }
}

/**
 * Registers a tool with a model context until `signal` aborts. `latest` returns the tool as the page has it now, so
 * execute sees current state; null when the page no longer offers it.
 */
export function registerWebMcpTool<I>(
  mc: Pick<WebMCP.ModelContext, 'registerTool'>,
  latest: () => WebMcpTool<I> | null,
  signal: AbortSignal,
): Promise<void> {
  const t = latest()
  if (!t) return Promise.resolve()
  if (!isToolName(t.name)) throw new Error(`Bad WebMCP tool name: ${t.name}`)
  return mc
    .registerTool(
      {
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: {
          readOnlyHint: t.kind === 'read',
          untrustedContentHint: t.kind !== 'consequential' && t.untrusted === true,
          consequentialHint: t.kind === 'consequential',
        },
        execute: (input, opts) => {
          const now = latest()
          if (!now)
            return Promise.resolve(fail('unavailable', 'This tool is not available on the page any more.'))
          return executeTool(now, input, opts.signal)
        },
      },
      { signal },
    )
    .catch((e: unknown) => {
      // A duplicate name or a browser that refuses: the page works as before, without the tool.
      console.warn('[webmcp] registerTool failed', t.name, e)
    })
}

/** Registers `tool` while mounted (null: nothing to offer yet, e.g. while the page loads). */
export function useWebMcpTool<I>(tool: WebMcpTool<I> | null): void {
  const available = useWebMcpAvailable()
  const latest = useRef(tool)
  latest.current = tool
  const present = tool !== null
  const name = tool?.name ?? ''
  const schema = JSON.stringify(tool?.input ?? null)
  useEffect(() => {
    const mc = document.modelContext
    if (!available || !present || !mc) return
    const controller = new AbortController()
    void registerWebMcpTool(mc, () => latest.current, controller.signal)
    return () => {
      controller.abort()
    }
  }, [available, present, name, schema])
}
