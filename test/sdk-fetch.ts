// The SDK tests' way into the in-process app. Like harness().call, it waits for the background work a request hands to
// waitUntil (the queue kick after a create) before answering, so that work never races the test's own sweep ticks.
import type { Harness } from './helpers.js'

export async function appFetch(h: Harness, req: Request): Promise<Response> {
  const pending: Promise<unknown>[] = []
  const res = await h.app.fetch(req, {
    context: { deploy: { published: true }, waitUntil: (p: Promise<unknown>) => void pending.push(p) },
  })
  await Promise.all(pending)
  return res
}
