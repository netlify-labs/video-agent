// The conversion Worker (./recording-convert.ts): reads the file's facts, converts it when it needs it, and posts
// ConvertMessage events back.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeVideo,
  Conversion,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  MP4,
  Output,
  Quality,
} from 'mediabunny'
import { convertSettings, needsConversion, type ConvertMessage, type VideoFacts } from './recording-convert'

const post = (m: ConvertMessage) => {
  postMessage(m)
}

async function facts(input: Input): Promise<VideoFacts> {
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('This file has no video.')
  const format = await input.getFormat()
  const sink = new EncodedPacketSink(track)
  const durations: number[] = []
  const keyframes: number[] = []
  // Metadata only: the timestamps without reading the frames.
  for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
    if (durations.length < 600) durations.push(p.duration)
    if (p.type === 'key') keyframes.push(p.timestamp)
  }
  return {
    container: format === MP4 ? 'mp4' : format.name.toLowerCase(),
    codec: await track.getCodec(),
    width: await track.getDisplayWidth(),
    height: await track.getDisplayHeight(),
    durations,
    keyframes,
    duration: await input.computeDuration(),
  }
}

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  const input = new Input({ source: new BlobSource(e.data.file), formats: ALL_FORMATS })
  try {
    const f = await facts(input)
    const reason = needsConversion(f)
    post({ type: 'facts', facts: f, reason })
    if (!reason) {
      post({ type: 'done', file: null })
      return
    }
    const { bitrate, ...settings } = convertSettings(f.width, f.height)
    const video = { ...settings, quality: new Quality(bitrate) }
    if (!(await canEncodeVideo('avc', { width: video.width ?? f.width, height: video.height ?? f.height }))) {
      post({ type: 'error', message: "This browser can't encode H.264.", unsupported: true })
      return
    }
    const target = new BufferTarget()
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
    const conversion = await Conversion.init({ input, output, video, audio: { discard: true } })
    if (!conversion.isValid) {
      post({ type: 'error', message: "This recording can't be converted: its video can't be read." })
      return
    }
    conversion.onProgress = (progress) => {
      post({ type: 'progress', progress })
    }
    await conversion.execute()
    if (!target.buffer) throw new Error("The recording couldn't be converted.")
    const name = e.data.file.name.replace(/\.[^.]+$/, '') + '.mp4'
    post({ type: 'done', file: new File([target.buffer], name, { type: 'video/mp4' }) })
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : "The recording couldn't be converted.",
    })
  }
}
