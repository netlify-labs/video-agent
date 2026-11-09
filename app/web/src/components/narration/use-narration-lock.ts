// useNarrationLock(videoId, draftId): the editor's narration soft lock (plan 2026-11-02 §2.7). Acquires on open,
// heartbeats every 30 s, releases on unmount and when the page goes away (a keepalive DELETE, since sendBeacon can
// only POST). `canEdit` gates Record and save; `takeOver` moves the lock here.
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchClient } from '../../api/client'
import {
  NarrationLockSession,
  type LockApi,
  type LockHolder,
  type LockResult,
  type NarrationLockState,
} from './narration-lock'

interface LockErrorBody {
  error?: {
    message?: string
    details?: {
      holder?: LockHolder | null
      takenOverBy?: { userId: string; name: string }
      at?: string
    }
  }
}

const refused = (status: number, body: unknown): LockResult => {
  const e = (body as LockErrorBody | undefined)?.error
  return {
    ok: false,
    status,
    message: e?.message ?? 'Something went wrong.',
    ...(e?.details?.holder !== undefined ? { holder: e.details.holder } : {}),
    ...(e?.details?.takenOverBy ? { takenOverBy: e.details.takenOverBy } : {}),
    ...(e?.details?.at ? { at: e.details.at } : {}),
  }
}

/** The lock endpoints for one video and draft. */
export function lockApi(videoId: string, draftId: string): LockApi {
  const path = { params: { path: { id: videoId } } }
  return {
    acquire: async (heartbeat) => {
      const { data, error, response } = await fetchClient.POST('/api/v1/videos/{id}/narration-lock', {
        ...path,
        body: { draftId, ...(heartbeat ? { heartbeat } : {}) },
      })
      return data ? { ok: true, holder: data.holder, mine: data.mine } : refused(response.status, error)
    },
    takeOver: async () => {
      const { data, error, response } = await fetchClient.POST(
        '/api/v1/videos/{id}/narration-lock/take-over',
        {
          ...path,
          body: { draftId },
        },
      )
      return data ? { ok: true, holder: data.lock.holder, mine: true } : refused(response.status, error)
    },
    release: () => {
      void fetch(`/api/v1/videos/${encodeURIComponent(videoId)}/narration-lock`, {
        method: 'DELETE',
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => undefined)
    },
  }
}

export function useNarrationLock(videoId: string | null, draftId: string | null, api?: LockApi) {
  const [state, setState] = useState<NarrationLockState>({ status: 'acquiring' })
  const session = useRef<NarrationLockSession | null>(null)
  const custom = useRef(api)
  custom.current = api
  useEffect(() => {
    if (!videoId || !draftId) return
    const s = new NarrationLockSession(custom.current ?? lockApi(videoId, draftId), setState)
    session.current = s
    s.start()
    const gone = () => s.stop()
    window.addEventListener('pagehide', gone)
    return () => {
      window.removeEventListener('pagehide', gone)
      s.stop()
      session.current = null
    }
  }, [videoId, draftId])
  const takeOver = useCallback(async () => {
    await session.current?.takeOver()
  }, [])
  return { state, canEdit: state.status === 'held', takeOver }
}
