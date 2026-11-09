// Makes a picked poster's files in the browser (app/server/domain/poster.ts checks and stores them): a JPEG up to 1920 px
// wide, WebPs 480 and 960 px wide when this browser can encode WebP, and a tiny blurred placeholder, all with the
// video's shape. A frame comes from the version's full MP4 (same origin, so the canvas can be read), seeked in a
// hidden <video>, not from the page's player, so it's the full-size picture whatever the player is showing.

export interface PosterFiles {
  jpg: string
  webp480?: string
  webp960?: string
  lqip?: string
}

const MAX_WIDTH = 1920
const LQIP_WIDTH = 24
/** The server's limit for the placeholder data URI. */
const MAX_LQIP_CHARS = 2048

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error("This browser can't draw the poster.")
  ctx.imageSmoothingQuality = 'high'
  return { c, ctx }
}

const blob = (c: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => {
    c.toBlob(resolve, type, quality)
  })

async function base64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Draws `src` cropped to the video's shape (cover), scaled to `w` wide. */
function draw(
  src: CanvasImageSource,
  sw: number,
  sh: number,
  video: { width: number; height: number },
  w: number,
) {
  const h = Math.round((w * video.height) / video.width)
  const { c, ctx } = canvas(w, h)
  const want = video.width / video.height
  let cw = sw
  let ch = sh
  if (sw / sh > want) cw = sh * want
  else ch = sw / want
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h)
  return c
}

/** Encodes the files from a source picture (a frame or an image) of size sw×sh. */
async function encode(
  src: CanvasImageSource,
  sw: number,
  sh: number,
  video: { width: number; height: number },
): Promise<PosterFiles> {
  const width = Math.min(MAX_WIDTH, video.width)
  const jpg = await blob(draw(src, sw, sh, video, width), 'image/jpeg', 0.88)
  if (!jpg) throw new Error("This browser couldn't make the poster.")
  const out: PosterFiles = { jpg: await base64(jpg) }
  for (const w of [480, 960] as const) {
    const b = await blob(draw(src, sw, sh, video, Math.min(w, video.width)), 'image/webp', 0.82)
    // Browsers that can't encode WebP hand back a PNG: leave the size out.
    if (b?.type === 'image/webp') out[w === 480 ? 'webp480' : 'webp960'] = await base64(b)
  }
  const small = draw(src, sw, sh, video, LQIP_WIDTH)
  for (const type of ['image/webp', 'image/jpeg']) {
    const uri = small.toDataURL(type, 0.5)
    if (uri.startsWith(`data:${type};`) && uri.length <= MAX_LQIP_CHARS) {
      out.lqip = uri
      break
    }
  }
  return out
}

/** The frame at `at` seconds of the video at `src` (a same-origin URL). */
export async function frameFiles(
  src: string,
  at: number,
  video: { width: number; height: number },
): Promise<PosterFiles> {
  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.preload = 'auto'
  el.crossOrigin = 'anonymous'
  try {
    await new Promise<void>((resolve, reject) => {
      el.addEventListener('loadeddata', () => resolve(), { once: true })
      el.addEventListener('error', () => reject(new Error("The video couldn't be loaded.")), { once: true })
      el.src = src
    })
    await new Promise<void>((resolve, reject) => {
      el.addEventListener('seeked', () => resolve(), { once: true })
      el.addEventListener('error', () => reject(new Error("The video couldn't be loaded.")), { once: true })
      el.currentTime = Math.min(Math.max(at, 0), Math.max((el.duration || at) - 0.05, 0))
    })
    return await encode(el, el.videoWidth, el.videoHeight, video)
  } finally {
    el.removeAttribute('src')
    el.load()
  }
}

/** An uploaded image, cropped to the video's shape from its centre. */
export async function imageFiles(file: File, video: { width: number; height: number }): Promise<PosterFiles> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    throw new Error("That file isn't an image this browser can open. Try a JPEG, PNG or WebP.")
  }
  try {
    return await encode(bmp, bmp.width, bmp.height, video)
  } finally {
    bmp.close()
  }
}
