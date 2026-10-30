// The agent's callback is a wake-up hint: store the manifest as a receipt and poke the reconciler.
import type { Deps } from '../deps.js'
import { safeEqual, sha256Hex } from '../lib/crypto.js'
import { ApiError } from '../lib/errors.js'
import { isManifest } from './finalize.js'
import { isTerminal } from './types.js'

export async function receiveCallback(
  deps: Deps,
  attemptId: string,
  token: string | null,
  body: unknown,
): Promise<void> {
  const a = await deps.store.getAttempt(attemptId)
  if (!a || !token || !a.callbackTokenHash || !safeEqual(a.callbackTokenHash, sha256Hex(token))) {
    throw new ApiError('unauthorized', 'Invalid callback token.')
  }
  const job = await deps.store.getJob(a.jobId)
  if (!job || job.deletedAt || a.cancelRequestedAt || (isTerminal(a.stage) && a.stage !== 'ready')) {
    throw new ApiError('gone', 'This attempt was cancelled or removed. Stop retrying.')
  }
  if (!isManifest(body, attemptId) || body.jobId !== a.jobId) {
    throw new ApiError('invalid_request', 'The manifest is missing fields or has the wrong ids.')
  }
  const hash = sha256Hex(JSON.stringify(body))
  await deps.store.tx(async (repo) => {
    const prior = await repo.getReceipt(attemptId)
    if (prior) {
      if (prior.manifestHash !== hash)
        throw new ApiError('conflict', 'A different manifest was already received for this attempt.')
      return
    }
    await repo.insertReceipt({
      attemptId,
      manifest: body,
      manifestHash: hash,
      receivedAt: deps.clock.now().toISOString(),
    })
    if (!isTerminal(a.stage))
      await repo.updateAttempt(attemptId, { nextActionAt: deps.clock.now().toISOString() })
  })
  deps.log.info('callback.received', { attemptId })
}
