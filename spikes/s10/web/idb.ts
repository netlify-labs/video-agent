// Spike S10: the recovery store, shared by the page and the recorder worker. One database, three stores:
//   takes  {id, status, ctxRate, startFrame, samples, chunks, pcmSha256 (running, over chunks 0..chunks-1), ...}
//   chunks {take, seq, pcm: ArrayBuffer}  24 kHz PCM16 little-endian, CHUNK_SAMPLES each (the last may be short)
//   clock  {take, fit, anchors, ...}      written by the page every few seconds
export const DB_NAME = 's10-recorder'
export const CHUNK_SAMPLES = 12_000 // 0.5 s at 24 kHz, 24 KB

export interface TakeRecord {
  id: string
  status: 'recording' | 'stopped' | 'uploaded'
  createdAt: number
  updatedAt: number
  ctxRate: number
  startFrame: number
  samples: number
  chunks: number
  pcmSha256: string
  fileSha256?: string
  meta?: unknown
}

export interface ChunkRecord {
  take: string
  seq: number
  pcm: ArrayBuffer
}

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1)
    r.onupgradeneeded = () => {
      const db = r.result
      db.createObjectStore('takes', { keyPath: 'id' })
      db.createObjectStore('chunks', { keyPath: ['take', 'seq'] })
      db.createObjectStore('clock', { keyPath: 'take' })
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('idb open'))
  })
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('idb tx'))
    tx.onabort = () => reject(tx.error ?? new Error('idb abort'))
  })

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('idb req'))
  })

export async function putMany(db: IDBDatabase, items: { store: string; value: unknown }[]): Promise<void> {
  const tx = db.transaction([...new Set(items.map((i) => i.store))], 'readwrite')
  for (const i of items) tx.objectStore(i.store).put(i.value)
  await done(tx)
}

export async function get<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return req(db.transaction(store).objectStore(store).get(key) as IDBRequest<T | undefined>)
}

export async function all<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return req(db.transaction(store).objectStore(store).getAll() as IDBRequest<T[]>)
}

export async function chunk(db: IDBDatabase, take: string, seq: number): Promise<ChunkRecord | undefined> {
  return get<ChunkRecord>(db, 'chunks', [take, seq])
}

/** Chunks [from, to) of a take in seq order, in one request (per-chunk gets cost ~2-4 ms each). */
export async function chunkRange(
  db: IDBDatabase,
  take: string,
  from: number,
  to: number,
): Promise<ChunkRecord[]> {
  const range = IDBKeyRange.bound([take, from], [take, to], false, true)
  return req(db.transaction('chunks').objectStore('chunks').getAll(range) as IDBRequest<ChunkRecord[]>)
}

/** Every chunk of a take in order, BATCH at a time (bounded memory). */
export async function* chunksOf(
  db: IDBDatabase,
  take: string,
  count: number,
  batch = 64,
): AsyncGenerator<ChunkRecord> {
  for (let s = 0; s < count; s += batch) {
    const got = await chunkRange(db, take, s, Math.min(count, s + batch))
    if (got.length !== Math.min(count, s + batch) - s) throw new Error(`missing chunks in ${s}..${s + batch}`)
    yield* got
  }
}

export async function deleteTake(db: IDBDatabase, take: string): Promise<void> {
  const tx = db.transaction(['takes', 'chunks', 'clock'], 'readwrite')
  tx.objectStore('takes').delete(take)
  tx.objectStore('clock').delete(take)
  tx.objectStore('chunks').delete(IDBKeyRange.bound([take, 0], [take, Infinity]))
  await done(tx)
}

export async function clearAll(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(['takes', 'chunks', 'clock'], 'readwrite')
  for (const s of ['takes', 'chunks', 'clock']) tx.objectStore(s).clear()
  await done(tx)
}
