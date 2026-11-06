// Uploading a screen recording (screen-recording plan §4.3, path C; va-rsk5.4.1): MOV, MP4 or WebM becomes the
// normalized format in the browser before it uploads (H.264, 30 fps CFR, a keyframe every second, fast start, at most
// 2560 px wide), with Mediabunny in a module Worker (D4: far under 1.5x real time in every browser). A file that already
// meets the rules uploads as is. The rules match the server's check (src/lib/media/classify.ts), which refuses the rest.
import { bitrateFor, encodedSize, FPS, MAX_WIDTH } from './screen-capture'

export interface VideoFacts {
  container: string
  codec: string | null
  width: number
  height: number
  /** Packet durations in seconds (the first few hundred are enough). */
  durations: number[]
  /** Keyframe timestamps in seconds. */
  keyframes: number[]
  duration: number
}

/** Why a file needs converting, or null when it already meets the rules. */
export function needsConversion(f: VideoFacts): string | null {
  if (f.container !== 'mp4') return 'not an MP4'
  if (f.codec !== 'avc') return 'not H.264'
  if (f.width > MAX_WIDTH) return `wider than ${String(MAX_WIDTH)} px`
  if (f.width % 2 || f.height % 2) return 'odd frame size'
  if (f.durations.some((d) => Math.abs(d - 1 / FPS) > 0.002)) return 'not a constant 30 fps'
  const gaps = f.keyframes.map((t, i) => (i ? t - (f.keyframes[i - 1] as number) : t))
  gaps.push(f.duration - (f.keyframes.at(-1) ?? 0))
  if (gaps.some((g) => g > 1.05)) return 'keyframes more than a second apart'
  return null
}

/** The conversion's video settings for a first frame of this size. */
export function convertSettings(width: number, height: number) {
  const size = encodedSize(width, height)
  return {
    codec: 'avc' as const,
    bitrate: bitrateFor(size.width, size.height),
    keyFrameInterval: 1,
    frameRate: FPS,
    ...(size.width !== width ? { width: size.width, height: size.height, fit: 'contain' as const } : {}),
    forceTranscode: true,
  }
}

/** Estimated bytes of the converted file. */
export const estimatedBytes = (width: number, height: number, seconds: number) => {
  const size = encodedSize(width, height)
  return Math.round((bitrateFor(size.width, size.height) / 8) * seconds)
}

export type ConvertMessage =
  | { type: 'facts'; facts: VideoFacts; reason: string | null }
  | { type: 'progress'; progress: number }
  | { type: 'done'; file: File | null }
  | { type: 'error'; message: string; unsupported?: boolean }

export class ConvertError extends Error {
  constructor(
    message: string,
    readonly unsupported = false,
  ) {
    super(message)
  }
}

/** What to run when this browser can't encode H.264: the same settings with ffmpeg. */
export const FFMPEG_COMMAND =
  'ffmpeg -i input.mov -vf "fps=30,scale=\'min(2560,iw)\':-2" -c:v libx264 -crf 22 -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p -movflags +faststart -an recording.mp4'

/**
 * Converts `file` when it needs it, in a Worker. Resolves with the file to upload: the original when it already meets
 * the rules. onFacts tells the caller the size and length (for the estimate) and whether a conversion runs.
 */
export function convertRecording(
  file: File,
  opts: {
    onFacts?: (facts: VideoFacts, reason: string | null) => void
    onProgress?: (p: number) => void
    signal?: AbortSignal
  } = {},
): Promise<File> {
  const worker = new Worker(new URL('./recording-convert.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<File>((resolve, reject) => {
    const end = () => {
      worker.terminate()
    }
    opts.signal?.addEventListener('abort', () => {
      end()
      reject(new ConvertError('Stopped.'))
    })
    worker.onmessage = (e: MessageEvent<ConvertMessage>) => {
      const m = e.data
      if (m.type === 'facts') opts.onFacts?.(m.facts, m.reason)
      else if (m.type === 'progress') opts.onProgress?.(m.progress)
      else if (m.type === 'done') {
        end()
        resolve(m.file ?? file)
      } else {
        end()
        reject(new ConvertError(m.message, m.unsupported))
      }
    }
    worker.onerror = (e) => {
      end()
      reject(new ConvertError(e.message || "The recording couldn't be converted."))
    }
    worker.postMessage({ file })
  })
}
