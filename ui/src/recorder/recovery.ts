// Recovering takes after a crash, a reload or a failed upload (plan 2026-11-02 §5.1, "Recovery record"). On editor
// load the takes this person recorded for this draft that weren't saved are offered again; recovering one rebuilds
// its WAV, hash, peaks and speech spans from the saved chunks (so a take cut off mid-recording comes back up to its
// last chunk, at most half a second short). Records are only ever listed for their owner, and anything older than
// RECOVERY_TTL_MS is swept first.
import { useCallback, useEffect, useState } from 'react'
import type { RecordedTake } from './recorder'
import { recoveryStore, type RecoveryStore, type TakeRecord } from './store'
import { finalizeTake } from './take-writer'

/** The user's takes for `draftId` that can still be recovered, newest first (expired ones are deleted first). */
export async function recoverableTakes(
  store: RecoveryStore,
  userId: string,
  draftId: string | null,
  now = Date.now(),
): Promise<TakeRecord[]> {
  if (!userId) return []
  await store.sweep(now)
  const takes = await store.listTakes(userId)
  return takes.filter((t) => t.userId === userId && t.draftId === draftId && t.chunks > 0)
}

/** Rebuilds a saved take; marks an interrupted one stopped. */
export async function recoverTake(store: RecoveryStore, rec: TakeRecord): Promise<RecordedTake> {
  const fin = await finalizeTake(store, rec, { rebuild: true })
  await store.patchTake(rec.id, {
    status: 'stopped',
    samples: fin.samples,
    pcmSha256: fin.pcmSha256,
    fileSha256: fin.sha256,
    stopReason: rec.stopReason ?? (rec.status === 'recording' ? 'interrupted' : null),
  })
  return {
    recordingId: rec.id,
    wav: fin.wav,
    sha256: fin.sha256,
    samples: fin.samples,
    peaks: fin.peaks ?? new Uint8Array(),
    speech: fin.speech ?? [],
    firstSampleContextTime: rec.ctxRate > 0 && rec.startFrame >= 0 ? rec.startFrame / rec.ctxRate : 0,
    stopReason: rec.stopReason ?? (rec.status === 'recording' ? 'interrupted' : null),
    persisted: true,
  }
}

export interface RecordingRecovery {
  /** The takes to offer; empty while loading. */
  takes: TakeRecord[]
  loading: boolean
  /** Rebuilds a take; the caller uploads it (useTakeUpload) and the record is cleared once it's saved. */
  recover: (id: string) => Promise<{ record: TakeRecord; take: RecordedTake }>
  discard: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

/** The editor's recovery offer for this person and draft (nothing while signed out). */
export function useRecordingRecovery(
  userId: string | null | undefined,
  draftId: string | null,
  store: Promise<RecoveryStore> = recoveryStore(),
): RecordingRecovery {
  const [takes, setTakes] = useState<TakeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [db] = useState(() => store)

  const refresh = useCallback(async () => {
    if (!userId) {
      setTakes([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setTakes(await recoverableTakes(await db, userId, draftId))
    } catch {
      setTakes([])
    } finally {
      setLoading(false)
    }
  }, [db, userId, draftId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const own = useCallback(
    async (id: string) => {
      const s = await db
      const rec = await s.getTake(id)
      if (!rec || rec.userId !== userId) throw new Error('That recording is not available.')
      return { s, rec }
    },
    [db, userId],
  )

  const recover = useCallback(
    async (id: string) => {
      const { s, rec } = await own(id)
      const take = await recoverTake(s, rec)
      setTakes((t) => t.filter((x) => x.id !== id))
      return { record: rec, take }
    },
    [own],
  )

  const discard = useCallback(
    async (id: string) => {
      const { s } = await own(id)
      await s.deleteTake(id)
      setTakes((t) => t.filter((x) => x.id !== id))
    },
    [own],
  )

  return { takes, loading, recover, discard, refresh }
}
