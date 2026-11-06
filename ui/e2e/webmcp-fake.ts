// A stand-in for the browser's document.modelContext (WebMCP), installed before the app loads, so Playwright can call
// the app's tools the way an agent would: by name, with JSON in and JSON out. It keeps tools until their registration's
// signal aborts, refuses duplicate names, and rejects bad names, like the spec's registerTool. The page scripts are
// strings: this file is typechecked without the DOM library.
import { expect, type Page } from '@playwright/test'

const FAKE = `(() => {
  const tools = new Map()
  const mc = {
    registerTool(tool, opts) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) return Promise.reject(new TypeError('Bad tool name'))
      if (tools.has(tool.name)) return Promise.reject(new DOMException('Duplicate tool name', 'InvalidStateError'))
      tools.set(tool.name, tool)
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => tools.delete(tool.name))
      return Promise.resolve()
    },
  }
  Object.defineProperty(document, 'modelContext', { value: mc, configurable: true })
  window.__webmcp = {
    names: () => [...tools.keys()].sort(),
    annotations: (name) => (tools.get(name) && tools.get(name).annotations) || null,
    call: async (name, input) => {
      const t = tools.get(name)
      if (!t) throw new Error('No tool named ' + name + '; registered: ' + [...tools.keys()].join(', '))
      return JSON.parse(JSON.stringify(await t.execute(input, { signal: new AbortController().signal })))
    },
  }
})()`

export async function installFakeModelContext(page: Page) {
  await page.addInitScript(FAKE)
}

export const toolNames = (page: Page) => page.evaluate<string[]>('window.__webmcp.names()')

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
  page.evaluate<Record<string, boolean> | null>(`window.__webmcp.annotations(${JSON.stringify(name)})`)

/** Calls a tool and returns its JSON result. A consequential tool waits for the person's click: don't await it then. */
export const callTool = <T = Record<string, unknown>>(page: Page, name: string, input: object = {}) =>
  page.evaluate<T>(`window.__webmcp.call(${JSON.stringify(name)}, ${JSON.stringify(input)})`)
