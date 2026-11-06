// A stand-in for the browser's document.modelContext (WebMCP), installed before the app loads, so Playwright can call
// the app's tools the way an agent would: by name, with JSON in and JSON out. It keeps tools until their registration's
// signal aborts, refuses duplicate names, and rejects bad names, like the spec's registerTool.
import { expect, type Page } from '@playwright/test'

export async function installFakeModelContext(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<
      string,
      { name: string; annotations?: object; execute: (i: object, o: object) => unknown }
    >()
    const mc = {
      registerTool(
        tool: { name: string; execute: (i: object, o: object) => unknown },
        opts?: { signal?: AbortSignal },
      ) {
        if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) return Promise.reject(new TypeError('Bad tool name'))
        if (tools.has(tool.name))
          return Promise.reject(new DOMException('Duplicate tool name', 'InvalidStateError'))
        tools.set(tool.name, tool)
        opts?.signal?.addEventListener('abort', () => tools.delete(tool.name))
        return Promise.resolve()
      },
    }
    Object.defineProperty(document, 'modelContext', { value: mc, configurable: true })
    ;(window as unknown as { __webmcp: object }).__webmcp = {
      names: () => [...tools.keys()].sort(),
      annotations: (name: string) => tools.get(name)?.annotations ?? null,
      call: async (name: string, input: object) => {
        const t = tools.get(name)
        if (!t) throw new Error(`No tool named ${name}; registered: ${[...tools.keys()].join(', ')}`)
        const result = await t.execute(input, { signal: new AbortController().signal })
        return JSON.parse(JSON.stringify(result)) as unknown
      },
    }
  })
}

type Fake = {
  names: () => string[]
  annotations: (n: string) => object | null
  call: (n: string, i: object) => Promise<unknown>
}

export const toolNames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __webmcp: Fake }).__webmcp.names())

/** Waits until the page has registered every one of these tools. */
export async function waitForTools(page: Page, names: string[]) {
  await expect
    .poll(async () => {
      const have = new Set(await toolNames(page))
      return names.filter((n) => !have.has(n))
    })
    .toEqual([])
}

export const annotations = (page: Page, name: string) =>
  page.evaluate((n) => (window as unknown as { __webmcp: Fake }).__webmcp.annotations(n), name)

/** Calls a tool and returns its JSON result. A consequential tool waits for the person's click: don't await it then. */
export const callTool = <T = Record<string, unknown>>(page: Page, name: string, input: object = {}) =>
  page.evaluate(({ n, i }) => (window as unknown as { __webmcp: Fake }).__webmcp.call(n, i), {
    n: name,
    i: input,
  }) as Promise<T>
