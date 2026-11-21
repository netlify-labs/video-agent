// The Worker of ./recording-bake.ts: trims, crops and draws the hidden boxes into every frame, then posts the MP4.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeVideo,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  type VideoSample,
} from 'mediabunny'
import { boxRect, type BakeEdits, type BakeMessage } from './recording-bake'
import { convertSettings } from './recording-convert'

const post = (m: BakeMessage) => {
  postMessage(m)
}

self.onmessage = async (e: MessageEvent<{ file: File; edits: BakeEdits }>) => {
  const { file, edits } = e.data
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('This recording has no video.')
    const frame = { width: await track.getDisplayWidth(), height: await track.getDisplayHeight() }
    const kept = edits.crop ?? { left: 0, top: 0, ...frame }
    const { bitrate, ...settings } = convertSettings(kept.width, kept.height)
    const out = { width: settings.width ?? kept.width, height: settings.height ?? kept.height }
    if (!(await canEncodeVideo('avc', out))) {
      post({ type: 'error', message: "This browser can't encode H.264.", unsupported: true })
      return
    }
    // Frames arrive cropped and on the output's clock, which starts at the trim's start.
    const t0 = edits.trim?.[0] ?? 0
    const canvas = new OffscreenCanvas(out.width, out.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error("This browser can't draw the hidden areas.")
    // As the render draws a hidden area: blurred past reading small text and darkened a little, or a flat box.
    const blur = Math.max(12, Math.round(out.width / 80))
    // A browser whose canvas can't blur (no `filter`) draws a flat box instead: never a box that hides nothing.
    const canBlur = 'filter' in ctx
    const process = (sample: VideoSample) => {
      const rects = edits.boxes.flatMap((b) => {
        const r = boxRect(b, sample.timestamp + t0, frame, edits.crop, out)
        return r ? [{ r, solid: b.solid }] : []
      })
      if (!rects.length) return sample
      ctx.filter = 'none'
      sample.draw(ctx, 0, 0, out.width, out.height)
      for (const { r, solid } of rects) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(...r)
        ctx.clip()
        if (solid || !canBlur) {
          ctx.fillStyle = '#9aa3ad'
          ctx.fillRect(...r)
        } else {
          ctx.filter = `blur(${String(blur)}px) brightness(0.82)`
          sample.draw(ctx, 0, 0, out.width, out.height)
        }
        ctx.restore()
      }
      return canvas
    }
    const target = new BufferTarget()
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
    const conversion = await Conversion.init({
      input,
      output,
      ...(edits.trim ? { trim: { start: edits.trim[0], end: edits.trim[1] } } : {}),
      video: {
        ...settings,
        quality: new Quality(bitrate),
        ...(edits.crop ? { crop: edits.crop } : {}),
        ...(edits.boxes.length ? { process, processedWidth: out.width, processedHeight: out.height } : {}),
      },
      audio: { discard: true },
    })
    if (!conversion.isValid) {
      post({ type: 'error', message: "The edits couldn't be applied: the recording's video can't be read." })
      return
    }
    conversion.onProgress = (progress) => {
      post({ type: 'progress', progress })
    }
    await conversion.execute()
    if (!target.buffer) throw new Error("The edits couldn't be applied.")
    post({ type: 'done', file: new File([target.buffer], file.name, { type: 'video/mp4' }) })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : "The edits couldn't be applied." })
  }
}
