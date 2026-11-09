// The take upload state machine in Node (plan 2026-11-02 §5.1, "Upload", "On stop"), with uploadFile and waitReady
// mocked and an in-memory recovery store: the steps in order with the recorder's hash, role, video, peaks and speech;
// the recovery copy cleared only after the save; failures keep it and retry() resumes at the failed step; a recovered
// take with a known media id skips the upload.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VAD_VERSION } from '../../../server/lib/peaks'
import type { UploadOptions } from '../lib/upload'
import type { RecordedTake, Recorder } from './recorder'
import { MemoryRecoveryStore } from './store'
import { takeRecord } from './take-fixture'
import { createTakeUpload, type TakeUploadConfig, type TakeUploadState } from './take-upload'

const take = (over: Partial<RecordedTake> = {}): RecordedTake => ({
  recordingId: 'take-1',
  wav: new Blob([new Uint8Array(44 + 2 * 480)], { type: 'audio/wav' }),
  sha256: 'a'.repeat(64),
  samples: 480,
  peaks: new Uint8Array([1, 2, 3]),
  speech: [[0, 480]],
  firstSampleContextTime: 1.25,
  stopReason: null,
  persisted: true,
  ...over,
})

let store: MemoryRecoveryStore
let states: TakeUploadState[]
const uploadFile = vi.fn<(f: File, o: UploadOptions) => Promise<string>>()
const waitReady = vi.fn<(id: string) => Promise<unknown>>()
const onTakeReady = vi.fn<TakeUploadConfig['onTakeReady']>()

const make = () =>
  createTakeUpload(
    { uploadFile, waitReady, store: async () => store },
    () => ({ userId: 'u_1', scopeJobId: 'vid_1', onTakeReady }),
    (s) => {
      if (states.at(-1) !== s.state) states.push(s.state)
    },
  )

beforeEach(async () => {
  store = new MemoryRecoveryStore()
  await store.patchTake('take-1', takeRecord({ chunks: 1, status: 'stopped', createdAt: 1_700_000_000_000 }))
  states = []
  uploadFile.mockReset().mockResolvedValue('med_1')
  waitReady.mockReset().mockResolvedValue({ status: 'ready' })
  onTakeReady.mockReset().mockResolvedValue(undefined)
})

describe('take upload', () => {
  it('stops, uploads with the worker hash, waits for ready, saves, then clears the recovery copy', async () => {
    const u = make()
    u.recording('take-1')
    const t = take()
    const recorder = { recordingId: 'take-1', stop: vi.fn(async () => t) } as unknown as Recorder
    await u.finish(recorder)
    expect(states).toEqual(['recording', 'finalizing', 'uploading', 'processing', 'saving', 'saved'])
    const [file, opts] = uploadFile.mock.calls[0] ?? []
    expect(file?.name).toBe('take-take-1.wav')
    expect(file?.type).toBe('audio/wav')
    expect(file?.size).toBe(t.wav.size)
    // The record's createdAt, so a reload's recovered copy resumes the same upload session.
    expect(file?.lastModified).toBe(1_700_000_000_000)
    expect(opts).toMatchObject({
      sha256: t.sha256,
      role: 'narration-take',
      scopeJobId: 'vid_1',
      userId: 'u_1',
      extra: { peaks: t.peaks, speech: { version: VAD_VERSION, spans: [[0, 480]], samples: 480 } },
    })
    expect(waitReady).toHaveBeenCalledWith('med_1', expect.anything())
    expect(onTakeReady).toHaveBeenCalledWith(
      'med_1',
      480,
      [[0, 480]],
      expect.objectContaining({ firstSampleContextTime: 1.25 }),
    )
    // waitReady before the save, the save before the clear.
    expect(waitReady.mock.invocationCallOrder[0]).toBeLessThan(onTakeReady.mock.invocationCallOrder[0] ?? 0)
    expect(await store.getTake('take-1')).toBeUndefined()
    expect(u.get()).toMatchObject({ state: 'saved', mediaId: 'med_1', error: null })
  })

  it('keeps the recovery copy when the upload fails, and retry() uploads again', async () => {
    uploadFile.mockRejectedValueOnce(new Error("Part 2 of 2 didn't arrive. Try again to resume."))
    const u = make()
    await u.upload(take())
    expect(u.get()).toMatchObject({
      state: 'failed',
      failedAt: 'uploading',
      error: expect.stringMatching(/Part 2/),
    })
    expect(await store.getTake('take-1')).toMatchObject({ upload: { state: 'failed', mediaId: null } })
    await u.retry()
    expect(uploadFile).toHaveBeenCalledTimes(2)
    // The same File both times, so uploadFile's remembered session resumes.
    expect(uploadFile.mock.calls[1]?.[0]).toBe(uploadFile.mock.calls[0]?.[0])
    expect(u.get().state).toBe('saved')
    expect(await store.getTake('take-1')).toBeUndefined()
  })

  it('keeps the recovery copy with its media id when the save fails; retry() only saves again', async () => {
    onTakeReady.mockRejectedValueOnce(new Error('The draft changed. Reload to see it.'))
    const u = make()
    await u.upload(take())
    expect(u.get()).toMatchObject({ state: 'failed', failedAt: 'saving', mediaId: 'med_1' })
    expect(await store.getTake('take-1')).toMatchObject({ upload: { state: 'failed', mediaId: 'med_1' } })
    await u.retry()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(waitReady).toHaveBeenCalledTimes(1)
    expect(onTakeReady).toHaveBeenCalledTimes(2)
    expect(u.get().state).toBe('saved')
  })

  it('fails at processing when the media is rejected, and retry() waits again', async () => {
    waitReady.mockRejectedValueOnce(new Error('The file was rejected.'))
    const u = make()
    await u.upload(take())
    expect(u.get()).toMatchObject({
      state: 'failed',
      failedAt: 'processing',
      error: 'The file was rejected.',
    })
    expect(onTakeReady).not.toHaveBeenCalled()
    await u.retry()
    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(u.get().state).toBe('saved')
  })

  it('resumes a recovered take whose media id is known without uploading it again', async () => {
    const rec = await store.patchTake('take-1', {
      upload: { state: 'processing', mediaId: 'med_9', error: null },
    })
    const u = make()
    await u.upload(take(), rec)
    expect(uploadFile).not.toHaveBeenCalled()
    expect(waitReady).toHaveBeenCalledWith('med_9', expect.anything())
    expect(onTakeReady.mock.calls[0]?.[0]).toBe('med_9')
    expect(states).toEqual(['processing', 'saving', 'saved'])
    expect(u.get().state).toBe('saved')
  })

  it('reports a recorder that fails to finalize', async () => {
    const u = make()
    const recorder = {
      recordingId: 'take-1',
      stop: vi.fn(async () => {
        throw new Error('The recorder worker failed.')
      }),
    } as unknown as Recorder
    await u.finish(recorder)
    expect(u.get()).toMatchObject({ state: 'failed', failedAt: 'finalizing' })
    expect(uploadFile).not.toHaveBeenCalled()
  })

  it('reset() during a step drops the rest of that run', async () => {
    let release: () => void = () => undefined
    waitReady.mockReturnValueOnce(new Promise((r) => (release = () => r({}))))
    const u = make()
    const p = u.upload(take())
    await vi.waitFor(() => expect(u.get().state).toBe('processing'))
    u.reset()
    release()
    await p
    expect(onTakeReady).not.toHaveBeenCalled()
    expect(u.get().state).toBe('idle')
  })

  it("doesn't touch the store for a take that wasn't persisted", async () => {
    const u = make()
    await u.upload(take({ recordingId: 'mem-1', persisted: false }))
    expect(u.get().state).toBe('saved')
    expect(await store.getTake('take-1')).toBeDefined()
  })
})
