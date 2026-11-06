// Recording the screen in the app (screen-recording plan §4.5, path B; va-rsk5.4.7). A page gets pixels only
// (getDisplayMedia: no pointer events, the cursor baked in), encoded live to the normalized format (§4.3: H.264,
// 30 fps CFR, a keyframe every second, fast start) with Mediabunny, so the file is ready when recording stops. D4
// (docs/spikes.md): Chromium hands the display track to MediaStreamVideoTrackSource with sizeChangeBehavior 'contain'
// (a resize keeps the first frame's size); WebKit can't pass the track to Mediabunny's worker and Firefox's realtime
// encoder drops frames, so they draw the track into a canvas at the first frame's size and add a frame every 1/30 s
// with CanvasSource, latencyMode 'quality'. v1 keeps the recording in memory: a 5-minute hard stop and a
// beforeunload guard (IndexedDB recovery is later, plan 5.3).

export const FPS = 30
export const MAX_SECONDS = 5 * 60
export const MAX_WIDTH = 2560

/** How this browser records: the track straight to the encoder, a canvas copy, or not at all (no H.264 encoder). */
export type CaptureMode = 'track' | 'canvas' | 'unsupported'

export interface CaptureSupport {
  displayMedia: boolean
  /** VideoEncoder can encode H.264 at the recording's size. */
  avc: boolean
  /** MediaStreamTrackProcessor exists on the page (Chromium): Mediabunny can take the track itself. */
  trackProcessor: boolean
}

export function captureMode(s: CaptureSupport): CaptureMode {
  if (!s.displayMedia || !s.avc) return 'unsupported'
  return s.trackProcessor ? 'track' : 'canvas'
}

/** The §4.3 bitrate: about 0.035 bits per pixel per frame (3.9 Mbps at 1440p), 1 to 8 Mbps. */
export function bitrateFor(width: number, height: number): number {
  return Math.round(Math.min(8e6, Math.max(1e6, width * height * FPS * 0.035)))
}

/** The encoded size for a first frame: at most 2560 wide, even sides. */
export function encodedSize(width: number, height: number): { width: number; height: number } {
  const s = Math.min(1, MAX_WIDTH / width)
  const even = (n: number) => Math.max(2, Math.floor((n * s) / 2) * 2)
  return { width: even(width), height: even(height) }
}

export async function captureSupport(): Promise<CaptureSupport> {
  const displayMedia =
    'mediaDevices' in navigator && typeof navigator.mediaDevices.getDisplayMedia === 'function'
  let avc = false
  if (typeof VideoEncoder !== 'undefined') {
    const { canEncodeVideo, Quality } = await import('mediabunny')
    avc = await canEncodeVideo('avc', {
      width: 1920,
      height: 1080,
      quality: new Quality(bitrateFor(1920, 1080)),
    }).catch(() => false)
  }
  return { displayMedia, avc, trackProcessor: 'MediaStreamTrackProcessor' in window }
}

export interface ScreenRecording {
  /** Seconds recorded so far. */
  elapsed: () => number
  /** Stops and finishes the file. Also called when sharing ends or at MAX_SECONDS; resolves once, with the same file. */
  stop: () => Promise<File>
  /** Stops and drops the recording. */
  cancel: () => void
  /** Resolves when recording stopped by itself (sharing ended in the browser, or the time limit). */
  ended: Promise<'shared-ended' | 'time-limit'>
}

export class CaptureError extends Error {}

const log = (event: string, fields: Record<string, unknown> = {}) => {
  console.info(JSON.stringify({ event: `screen_capture.${event}`, ...fields }))
}

/** Asks for a tab, window or screen and starts recording it. Throws CaptureError when it can't start. */
export async function startScreenRecording(
  mode: Exclude<CaptureMode, 'unsupported'>,
): Promise<ScreenRecording> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: FPS, width: { ideal: MAX_WIDTH } },
      audio: false,
      selfBrowserSurface: 'exclude',
    } as DisplayMediaStreamOptions)
  } catch (e) {
    const denied = e instanceof DOMException && e.name === 'NotAllowedError'
    log('denied', { name: e instanceof DOMException ? e.name : 'Error' })
    throw new CaptureError(denied ? 'Recording was cancelled.' : "The screen couldn't be shared.")
  }
  const track = stream.getVideoTracks()[0]
  if (!track) throw new CaptureError("The screen couldn't be shared.")
  const MB = await import('mediabunny')

  // The first frame's size, from a <video> playing the track (settings can be missing or late in some browsers).
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([track])
  await video.play()
  for (let i = 0; !video.videoWidth && i < 200; i++) await new Promise((r) => setTimeout(r, 10))
  if (!video.videoWidth) {
    track.stop()
    throw new CaptureError('The shared screen sent no picture.')
  }
  const size = encodedSize(video.videoWidth, video.videoHeight)
  const bitrate = bitrateFor(size.width, size.height)
  const target = new MB.BufferTarget()
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  log('start', { mode, width: size.width, height: size.height, bitrate })

  let addFrames: (() => Promise<void>) | null = null
  let stopFrames = () => {}
  if (mode === 'track') {
    const source = new MB.MediaStreamVideoTrackSource(
      track,
      {
        codec: 'avc',
        quality: new MB.Quality(bitrate),
        keyFrameInterval: 1,
        sizeChangeBehavior: 'contain',
        latencyMode: 'realtime',
      },
      { frameRate: FPS },
    )
    output.addVideoTrack(source, { frameRate: FPS })
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const cx = canvas.getContext('2d')
    if (!cx) throw new CaptureError("This browser can't record the screen.")
    const source = new MB.CanvasSource(canvas, {
      codec: 'avc',
      quality: new MB.Quality(bitrate),
      keyFrameInterval: 1,
      latencyMode: 'quality',
    })
    output.addVideoTrack(source, { frameRate: FPS })
    // An object, so the loop sees stopFrames flip it across its awaits.
    const run: { on: boolean } = { on: true }
    const running = () => run.on
    stopFrames = () => {
      run.on = false
    }
    addFrames = async () => {
      const t0 = performance.now()
      for (let k = 0; running(); k++) {
        const wait = t0 + (k * 1000) / FPS - performance.now()
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        if (!running()) break
        // Contain the (possibly resized) frame in the first frame's box.
        const s = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight)
        const dw = video.videoWidth * s
        const dh = video.videoHeight * s
        cx.fillStyle = '#000'
        cx.fillRect(0, 0, canvas.width, canvas.height)
        cx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh)
        await source.add(k / FPS, 1 / FPS)
      }
    }
  }
  await output.start()
  const started = performance.now()
  const framing = addFrames?.()

  let finishing: Promise<File> | null = null
  let endedBy: (why: 'shared-ended' | 'time-limit') => void = () => {}
  const ended = new Promise<'shared-ended' | 'time-limit'>((r) => (endedBy = r))
  const release = () => {
    clearTimeout(limit)
    window.removeEventListener('beforeunload', guard)
    track.removeEventListener('ended', onEnded)
    track.stop()
    video.srcObject = null
  }
  const stop = () =>
    (finishing ??= (async () => {
      const seconds = (performance.now() - started) / 1000
      stopFrames()
      await framing
      await output.finalize()
      release()
      if (!target.buffer) throw new CaptureError("The recording couldn't be finished.")
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      log('stop', { seconds: Math.round(seconds * 10) / 10, bytes: target.buffer.byteLength })
      return new File([target.buffer], `screen-${stamp}.mp4`, { type: 'video/mp4' })
    })())
  const guard = (e: BeforeUnloadEvent) => {
    e.preventDefault()
  }
  const onEnded = () => {
    endedBy('shared-ended')
  }
  window.addEventListener('beforeunload', guard)
  track.addEventListener('ended', onEnded)
  const limit = setTimeout(() => {
    endedBy('time-limit')
  }, MAX_SECONDS * 1000)
  return {
    elapsed: () => (performance.now() - started) / 1000,
    stop,
    cancel: () => {
      stopFrames()
      void output.cancel().catch(() => undefined)
      release()
      log('cancel')
    },
    ended,
  }
}
