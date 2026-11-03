// useTakeUpload: the take upload state machine (take-upload.ts) for React, on the real uploader and recovery store.
// The record flow calls recording(id) when a take starts, finish(recorder) on stop (or upload(take, record) for a
// recovered one), and renders `state`; onTakeReady adds the clip to the NarrationOp and saves the draft.
import { useEffect, useRef, useState } from 'react'
import { uploadFile, waitReady } from '../lib/upload'
import { recoveryStore } from './store'
import {
  createTakeUpload,
  type TakeUpload,
  type TakeUploadConfig,
  type TakeUploadDeps,
  type TakeUploadSnapshot,
} from './take-upload'

const DEPS: TakeUploadDeps = { uploadFile, waitReady, store: recoveryStore }

export function useTakeUpload(
  config: TakeUploadConfig,
  deps: TakeUploadDeps = DEPS,
): TakeUploadSnapshot & Omit<TakeUpload, 'get'> {
  // The latest config (onTakeReady closes over the draft), read when a step runs.
  const latest = useRef(config)
  latest.current = config
  const [snap, setSnap] = useState<TakeUploadSnapshot>(() => ({
    state: 'idle',
    recordingId: null,
    mediaId: null,
    progress: null,
    error: null,
    failedAt: null,
  }))
  const [ctl] = useState(() => createTakeUpload(deps, () => latest.current, setSnap))
  useEffect(() => () => ctl.reset(), [ctl])
  return {
    ...snap,
    recording: ctl.recording,
    finish: ctl.finish,
    upload: ctl.upload,
    retry: ctl.retry,
    reset: ctl.reset,
  }
}
