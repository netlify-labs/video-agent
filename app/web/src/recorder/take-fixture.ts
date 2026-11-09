// A take record for the recorder's Node tests.
import type { TakeRecord } from './store'

export function takeRecord(over: Partial<TakeRecord> = {}): TakeRecord {
  return {
    id: 'take-1',
    userId: 'u_1',
    draftId: 'draft_1',
    expectedRev: 3,
    scopeJobId: 'vid_1',
    status: 'recording',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ctxRate: 48_000,
    startFrame: -1,
    samples: 0,
    chunks: 0,
    pcmSha256: '',
    fileSha256: null,
    route: null,
    clock: null,
    placement: null,
    upload: { state: 'pending', mediaId: null, error: null },
    stopReason: null,
    ...over,
  }
}
