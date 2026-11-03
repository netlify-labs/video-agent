// The recovery store for recorded takes (plan 2026-11-02 §5.1, "Recovery record"). The recorder worker writes every
// chunk of a take here from the first one, so a crash, a reload or a quota error never loses what was captured; the
// editor offers the unsaved takes again on load. One record per recording UUID:
//
//   takes   TakeRecord: owner (user id), draft id + expectedRev, device route, clock anchors + fit (reserved: the
//           sync-clock bead fills them), progress (samples, chunks, the running PCM hash) and upload state
//   chunks  {take, seq, pcm}: 24 kHz PCM16 little-endian, CHUNK_SAMPLES each (only the last may be short), so chunk
//           seq starts at source sample seq × CHUNK_SAMPLES
//
// Records belong to a user id and are only ever listed for that id. They are cleared once the media is ready and the
// draft save that references it has succeeded, on discard, or RECOVERY_TTL_MS after they were made.
//
// RecoveryStore is the interface; IdbRecoveryStore is the browser one (main thread and worker share the database)
// and MemoryRecoveryStore backs the tests and the worker when IndexedDB can't be opened (private mode: the take still
// records, it just can't be recovered).
import type { Fit } from '../../../src/lib/timeline'

export const DB_NAME = 'va-recorder'
export const CHUNK_SAMPLES = 12_000 // 0.5 s at 24 kHz, 24 KB
export const RECOVERY_TTL_MS = 7 * 24 * 3600_000

/** The take's place in the upload pipeline (§5.1, "Upload"); 'saved' records are deleted, so it's rarely seen. */
export type UploadState = 'pending' | 'uploading' | 'processing' | 'ready' | 'saved' | 'failed'

/** The input (and output) the take was recorded on; calibration is keyed to it (§5.3). */
export interface DeviceRoute {
  inputDeviceId: string
  inputLabel: string
  groupId: string
  outputDeviceId: string | null
  sampleRate: number
  echoCancellation: boolean
}

export interface TakeRecord {
  /** Recording UUID. */
  id: string
  /** The owner: never offered to another account. */
  userId: string
  draftId: string | null
  expectedRev: number | null
  /** The video the take is recorded for (the upload session's scopeJobId). */
  scopeJobId: string | null
  /** 'recording' until the worker finalizes it; a record left 'recording' was interrupted. */
  status: 'recording' | 'stopped'
  createdAt: number
  updatedAt: number
  ctxRate: number
  /** Context frame of the first captured sample; -1 until the first block. */
  startFrame: number
  samples: number
  chunks: number
  /** SHA-256 over chunks 0..chunks-1 (the WAV's data chunk), as written so far. */
  pcmSha256: string
  /** SHA-256 of the whole WAV file, set when the take is finalized. */
  fileSha256: string | null
  route: DeviceRoute | null
  /** Reserved for the sync clock (§5.3): picture anchors and the fit t = a + b·sample. */
  clock: { anchors: unknown[]; fit: Fit | null } | null
  /** Reserved for the record flow: where the take goes on the timeline (composition sample of source sample 0). */
  placement: { start: number; offsetSamples: number } | null
  upload: { state: UploadState; mediaId: string | null; error: string | null }
  /** Why the take stopped early (quota, device change...), when it did. */
  stopReason: string | null
}

export interface ChunkRecord {
  take: string
  seq: number
  pcm: ArrayBuffer
}

export interface RecoveryStore {
  /** Writes one chunk and merges `progress` into its take record, atomically (the record is created if missing). */
  putChunk(chunk: ChunkRecord, progress: Partial<TakeRecord> & Pick<TakeRecord, 'id'>): Promise<void>
  /** Merges fields into a take record (creating it from `patch` when it doesn't exist). */
  patchTake(id: string, patch: Partial<TakeRecord>): Promise<TakeRecord | undefined>
  getTake(id: string): Promise<TakeRecord | undefined>
  /** The user's takes, newest first. */
  listTakes(userId: string): Promise<TakeRecord[]>
  /** Chunks [from, to) of a take, in seq order. */
  chunkRange(take: string, from: number, to: number): Promise<ChunkRecord[]>
  deleteTake(id: string): Promise<void>
  /** Deletes every take (any owner) made before now - RECOVERY_TTL_MS; resolves with how many. */
  sweep(now?: number): Promise<number>
}

/** True for the errors a full disk or a storage quota gives (stop the take, keep what was saved). */
export const isQuotaError = (e: unknown): boolean =>
  !!e &&
  typeof e === 'object' &&
  'name' in e &&
  ((e as { name: string }).name === 'QuotaExceededError' ||
    (e as { name: string }).name === 'NS_ERROR_DOM_QUOTA_REACHED')

const expired = (t: TakeRecord, now: number) => t.createdAt < now - RECOVERY_TTL_MS
const merge = (prior: TakeRecord | undefined, patch: Partial<TakeRecord>): TakeRecord =>
  ({ ...prior, ...patch, updatedAt: Date.now() }) as TakeRecord

/** Every chunk of a take in order, `batch` at a time (bounded memory). Throws when one is missing. */
export async function* chunksOf(
  store: RecoveryStore,
  take: string,
  count: number,
  batch = 64,
): AsyncGenerator<ChunkRecord> {
  for (let s = 0; s < count; s += batch) {
    const want = Math.min(count, s + batch) - s
    const got = await store.chunkRange(take, s, s + want)
    if (got.length !== want) throw new Error(`recovery: missing chunks in ${s}..${s + want}`)
    yield* got
  }
}

// ---- in memory

export class MemoryRecoveryStore implements RecoveryStore {
  readonly takes = new Map<string, TakeRecord>()
  readonly chunks = new Map<string, ChunkRecord>()
  private bytes = 0

  /** `quotaBytes` simulates a storage quota: a chunk write past it fails with a QuotaExceededError. */
  constructor(private readonly quotaBytes = Infinity) {}

  async putChunk(chunk: ChunkRecord, progress: Partial<TakeRecord> & Pick<TakeRecord, 'id'>) {
    if (this.bytes + chunk.pcm.byteLength > this.quotaBytes)
      throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
    this.bytes += chunk.pcm.byteLength
    this.chunks.set(`${chunk.take}:${chunk.seq}`, chunk)
    this.takes.set(progress.id, merge(this.takes.get(progress.id), progress))
  }

  async patchTake(id: string, patch: Partial<TakeRecord>) {
    const next = merge(this.takes.get(id), { ...patch, id })
    this.takes.set(id, next)
    return next
  }

  async getTake(id: string) {
    return this.takes.get(id)
  }

  async listTakes(userId: string) {
    return [...this.takes.values()].filter((t) => t.userId === userId).sort((a, b) => b.createdAt - a.createdAt)
  }

  async chunkRange(take: string, from: number, to: number) {
    const out: ChunkRecord[] = []
    for (let s = from; s < to; s++) {
      const c = this.chunks.get(`${take}:${s}`)
      if (c) out.push(c)
    }
    return out
  }

  async deleteTake(id: string) {
    this.takes.delete(id)
    for (const [k, c] of this.chunks)
      if (c.take === id) {
        this.bytes -= c.pcm.byteLength
        this.chunks.delete(k)
      }
  }

  async sweep(now = Date.now()) {
    const old = [...this.takes.values()].filter((t) => expired(t, now))
    for (const t of old) await this.deleteTake(t.id)
    return old.length
  }
}

// ---- IndexedDB

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve()
    }
    tx.onerror = () => {
      reject(tx.error ?? new Error('recovery: transaction failed'))
    }
    tx.onabort = () => {
      reject(tx.error ?? new Error('recovery: transaction aborted'))
    }
  })

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => {
      resolve(r.result)
    }
    r.onerror = () => {
      reject(r.error ?? new Error('recovery: request failed'))
    }
  })

export function openRecoveryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1)
    r.onupgradeneeded = () => {
      const db = r.result
      db.createObjectStore('takes', { keyPath: 'id' }).createIndex('userId', 'userId')
      db.createObjectStore('chunks', { keyPath: ['take', 'seq'] })
    }
    r.onsuccess = () => {
      resolve(r.result)
    }
    r.onerror = () => {
      reject(r.error ?? new Error('recovery: the database could not be opened'))
    }
    r.onblocked = () => {
      reject(new Error('recovery: the database is blocked by another tab'))
    }
  })
}

export class IdbRecoveryStore implements RecoveryStore {
  constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<IdbRecoveryStore> {
    return new IdbRecoveryStore(await openRecoveryDb())
  }

  /** Read-modify-write of one take inside `tx`, so the worker's progress and the page's clock fields don't clobber. */
  private mergeIn(tx: IDBTransaction, id: string, patch: Partial<TakeRecord>): Promise<TakeRecord> {
    const takes = tx.objectStore('takes')
    return req(takes.get(id) as IDBRequest<TakeRecord | undefined>).then((prior) => {
      const next = merge(prior, { ...patch, id })
      takes.put(next)
      return next
    })
  }

  async putChunk(chunk: ChunkRecord, progress: Partial<TakeRecord> & Pick<TakeRecord, 'id'>) {
    const tx = this.db.transaction(['chunks', 'takes'], 'readwrite')
    const finished = done(tx)
    tx.objectStore('chunks').put(chunk)
    void this.mergeIn(tx, progress.id, progress).catch(() => undefined)
    await finished
  }

  async patchTake(id: string, patch: Partial<TakeRecord>) {
    const tx = this.db.transaction('takes', 'readwrite')
    const finished = done(tx)
    const next = await this.mergeIn(tx, id, patch)
    await finished
    return next
  }

  async getTake(id: string) {
    return req(this.db.transaction('takes').objectStore('takes').get(id) as IDBRequest<TakeRecord | undefined>)
  }

  async listTakes(userId: string) {
    const all = await req(
      this.db.transaction('takes').objectStore('takes').index('userId').getAll(userId) as IDBRequest<
        TakeRecord[]
      >,
    )
    return all.sort((a, b) => b.createdAt - a.createdAt)
  }

  async chunkRange(take: string, from: number, to: number) {
    const range = IDBKeyRange.bound([take, from], [take, to], false, true)
    return req(this.db.transaction('chunks').objectStore('chunks').getAll(range) as IDBRequest<ChunkRecord[]>)
  }

  async deleteTake(id: string) {
    const tx = this.db.transaction(['takes', 'chunks'], 'readwrite')
    tx.objectStore('takes').delete(id)
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]))
    await done(tx)
  }

  async sweep(now = Date.now()) {
    const all = await req(this.db.transaction('takes').objectStore('takes').getAll() as IDBRequest<TakeRecord[]>)
    const old = all.filter((t) => expired(t, now))
    for (const t of old) await this.deleteTake(t.id)
    return old.length
  }

  close(): void {
    this.db.close()
  }
}

let shared: Promise<RecoveryStore> | null = null
/** The page's store, opened once; falls back to memory (no recovery across reloads) when IndexedDB is unavailable. */
export function recoveryStore(): Promise<RecoveryStore> {
  shared ??= IdbRecoveryStore.open().catch(() => new MemoryRecoveryStore())
  return shared
}
