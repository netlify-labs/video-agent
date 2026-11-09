// The recorder worker (plan 2026-11-02 §5.1): plumbing around TakeWriter (take-writer.ts). The page sends 'init' with
// the take record and a MessagePort to the worklet; blocks arrive on that port straight from the audio thread. Chunks
// go to IndexedDB (the recovery store) from the first one, or to memory when IndexedDB can't be opened.
//
// To the page: 'ready' {persisted}, 'progress' {samples, chunks}, 'interrupted' {reason} at the first failed write (the
// page stops the take; what was saved is kept), 'done' {take: FinalTake} and 'error' {error}.
import { IdbRecoveryStore, MemoryRecoveryStore, type RecoveryStore, type TakeRecord } from './store'
import { TakeWriter } from './take-writer'

export interface WorkerInit {
  type: 'init'
  record: TakeRecord
  port: MessagePort
  /** false: keep the chunks in memory only (no recovery). */
  persist: boolean
}
type FromWorklet = { type: 'block'; frame: number; samples: Float32Array } | { type: 'end' }

interface Scope {
  postMessage(m: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<WorkerInit>) => void) | null
}
const scope = self as unknown as Scope

async function openStore(persist: boolean): Promise<{ store: RecoveryStore; persisted: boolean }> {
  if (persist)
    try {
      return { store: await IdbRecoveryStore.open(), persisted: true }
    } catch {
      // private mode or storage disabled: record anyway
    }
  return { store: new MemoryRecoveryStore(), persisted: false }
}

scope.onmessage = (ev: MessageEvent<WorkerInit>) => {
  const m = ev.data
  const fail = (err: unknown) => {
    scope.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
  const ready = openStore(m.persist).then(async ({ store, persisted }) => {
    const w = new TakeWriter(store, m.record, {
      onProgress: (p) => {
        scope.postMessage({ type: 'progress', ...p })
      },
      onFailure: (reason) => {
        scope.postMessage({ type: 'interrupted', reason })
      },
    })
    await w.open()
    scope.postMessage({ type: 'ready', persisted })
    return w
  })
  ready.catch(fail)
  // Blocks are handled in arrival order: each waits for the store to open, then runs synchronously.
  let queue: Promise<unknown> = ready
  m.port.onmessage = (e: MessageEvent<FromWorklet>) => {
    const d = e.data
    queue = queue
      .then(() => ready)
      .then(async (w) => {
        if (d.type === 'block') w.block(d.frame, d.samples)
        else {
          const take = await w.end()
          scope.postMessage({ type: 'done', take })
        }
      })
      .catch(fail)
  }
}
