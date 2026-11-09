// netlify-video-agent-player: <video-agent-player>, a web component that plays a published Video Agent video on any
// page (docs/plans/2026-11-04-cli-and-sdk.md §7). No dependencies, Shadow DOM.
//
//   <script type="module" src="https://acme-video.netlify.app/player.js"></script>
//   <video-agent-player src="https://acme-video.netlify.app/v/k3t9x2abcd"></video-agent-player>
//
// `src` is a share link: the player reads its /v/{slug}.json for the size, poster, placeholder, captions and credits.
// Or set mp4, poster, captions, width and height yourself (private videos: signed URLs from the SDK, which last 5 to
// 10 minutes, so set them right before playing). The box has its aspect ratio before anything loads, so nothing
// shifts. CC BY credits show under the video whenever it has any; no attribute hides them.

/** This package's name, as published. */
export const PACKAGE_NAME = 'netlify-video-agent-player'

/** A CC BY credit, as /v/{slug}.json lists it (app/server/lib/credit-html.ts on the server). */
export interface Credit {
  role: string
  title: string
  creator: string | null
  creatorUrl: string | null
  licenseLabel: string
  licenseUrl: string | null
  sourceUrl: string | null
}

/** What `loaded` carries, and what the share link's JSON provides. */
export interface PlayerMetadata {
  title: string | null
  width: number
  height: number
  mp4: string
  poster: string | null
  posterWebp: string | null
  captions: string | null
  durationSec: number | null
  lqip: string | null
  credits: Credit[]
  videoId: string | null
  versionN: number | null
}

const STYLE = `:host{display:block;max-width:100%}figure{margin:0}.box{position:relative;width:100%;background:#000 center/cover no-repeat;border-radius:inherit;overflow:hidden}video{position:absolute;inset:0;width:100%;height:100%;display:block;background:transparent}figcaption{font:12px/1.4 system-ui,sans-serif;opacity:.8;margin-top:6px}figcaption a{color:inherit}.error{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:16px;text-align:center}`

const ATTRS = [
  'src',
  'mp4',
  'poster',
  'captions',
  'width',
  'height',
  'autoplay',
  'muted',
  'loop',
  'controls',
] as const
const EVENTS = ['play', 'pause', 'ended', 'timeupdate'] as const

const http = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null)

// Importable where there's no DOM (server rendering, Node): the element only defines itself in a browser.
const Base = typeof HTMLElement === 'undefined' ? (Object as unknown as typeof HTMLElement) : HTMLElement

export class VideoAgentPlayer extends Base {
  static readonly observedAttributes = [...ATTRS]

  readonly #box: HTMLDivElement
  readonly #video: HTMLVideoElement
  readonly #caption: HTMLElement
  #meta: PlayerMetadata | null = null
  #loading = 0

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLE
    const figure = document.createElement('figure')
    this.#box = document.createElement('div')
    this.#box.className = 'box'
    this.#box.setAttribute('part', 'box')
    this.#video = document.createElement('video')
    this.#video.setAttribute('part', 'video')
    this.#video.preload = 'metadata'
    this.#video.playsInline = true
    this.#caption = document.createElement('figcaption')
    this.#caption.setAttribute('part', 'credits')
    this.#caption.hidden = true
    this.#box.append(this.#video)
    figure.append(this.#box, this.#caption)
    root.append(style, figure)
    for (const type of EVENTS)
      this.#video.addEventListener(type, () =>
        this.dispatchEvent(new Event(type, { bubbles: true, composed: true })),
      )
  }

  connectedCallback() {
    void this.#load()
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null) {
    if (old === value || !this.isConnected) return
    if (name === 'autoplay' || name === 'muted' || name === 'loop' || name === 'controls') this.#flags()
    else void this.#load()
  }

  /** The metadata the player is showing (after `loaded`). */
  get metadata(): PlayerMetadata | null {
    return this.#meta
  }
  get currentTime() {
    return this.#video.currentTime
  }
  set currentTime(t: number) {
    this.#video.currentTime = t
  }
  get muted() {
    return this.#video.muted
  }
  set muted(m: boolean) {
    this.#video.muted = m
  }
  get paused() {
    return this.#video.paused
  }
  get duration() {
    return this.#video.duration
  }
  play() {
    return this.#video.play()
  }
  pause() {
    this.#video.pause()
  }

  #flags() {
    const v = this.#video
    v.controls = this.getAttribute('controls') !== 'false'
    v.loop = this.hasAttribute('loop')
    // Autoplay only works muted in browsers, so asking for it mutes the video.
    v.autoplay = this.hasAttribute('autoplay')
    v.muted = this.hasAttribute('muted') || v.autoplay
  }

  async #load() {
    const run = ++this.#loading
    const src = this.getAttribute('src')
    // Size the box now, before any request: width/height attributes, else 16:9 until the share link's JSON says.
    if (!this.#box.style.aspectRatio)
      this.#box.style.aspectRatio = `${Number(this.getAttribute('width')) || 16} / ${Number(this.getAttribute('height')) || 9}`
    let meta: PlayerMetadata | null
    try {
      meta = src ? await this.#fromShareLink(src) : this.#fromAttributes()
    } catch (e) {
      if (run === this.#loading)
        this.#error(e instanceof Error ? e.message : 'This video could not be loaded.')
      return
    }
    // A newer src won while this one loaded.
    if (run !== this.#loading || !meta) return
    this.#meta = meta
    this.#render(meta)
    this.dispatchEvent(new CustomEvent('loaded', { detail: meta, bubbles: true, composed: true }))
  }

  async #fromShareLink(src: string): Promise<PlayerMetadata> {
    const url = new URL(src, document.baseURI)
    const m = /^\/v\/([a-z2-9]{6,32})(?:\.json)?\/?$/.exec(url.pathname)
    if (!m) throw new Error('src must be a Video Agent share link (…/v/<slug>).')
    const res = await fetch(`${url.origin}/v/${m[1]}.json`, { headers: { accept: 'application/json' } })
    if (res.status === 404) throw new Error('This video is not published.')
    if (!res.ok) throw new Error(`This video could not be loaded (HTTP ${res.status}).`)
    const j = (await res.json()) as {
      title?: string
      width?: number
      height?: number
      video_agent?: Partial<Omit<PlayerMetadata, 'title' | 'width' | 'height'>>
    }
    const va = j.video_agent ?? {}
    if (!va.mp4 || !j.width || !j.height) throw new Error('This video could not be loaded.')
    return {
      title: j.title ?? null,
      width: j.width,
      height: j.height,
      mp4: va.mp4,
      poster: va.poster ?? null,
      posterWebp: va.posterWebp ?? null,
      captions: va.captions ?? null,
      durationSec: va.durationSec ?? null,
      lqip: va.lqip ?? null,
      credits: Array.isArray(va.credits) ? va.credits : [],
      videoId: va.videoId ?? null,
      versionN: va.versionN ?? null,
    }
  }

  #fromAttributes(): PlayerMetadata | null {
    const mp4 = this.getAttribute('mp4')
    if (!mp4) return null
    return {
      title: this.getAttribute('title'),
      width: Number(this.getAttribute('width')) || 16,
      height: Number(this.getAttribute('height')) || 9,
      mp4,
      poster: this.getAttribute('poster'),
      posterWebp: null,
      captions: this.getAttribute('captions'),
      durationSec: null,
      lqip: null,
      credits: [],
      videoId: null,
      versionN: null,
    }
  }

  #render(meta: PlayerMetadata) {
    this.#box.querySelector('.error')?.remove()
    // The box is sized before the video loads, so the page never shifts.
    this.#box.style.aspectRatio = `${meta.width} / ${meta.height}`
    this.#box.style.backgroundImage = meta.lqip ? `url("${meta.lqip}")` : ''
    const v = this.#video
    v.hidden = false
    v.width = meta.width
    v.height = meta.height
    v.poster = meta.posterWebp ?? meta.poster ?? ''
    if (meta.title) v.setAttribute('aria-label', meta.title)
    // Public share-link files allow any origin, so their captions track loads cross-origin. Explicit (often signed,
    // private) URLs don't send CORS headers, so they play without it.
    if (this.hasAttribute('src')) v.crossOrigin = 'anonymous'
    else v.removeAttribute('crossorigin')
    v.src = meta.mp4
    v.replaceChildren()
    if (meta.captions) {
      const track = document.createElement('track')
      track.kind = 'captions'
      track.src = meta.captions
      track.srclang = 'en'
      track.label = 'Captions'
      track.default = true
      v.append(track)
    }
    this.#flags()
    this.#credits(meta.credits)
  }

  /** "Music: <Title> by <Creator>, <CC BY 4.0>", one line per credit; only http(s) links. */
  #credits(credits: Credit[]) {
    const out = this.#caption
    out.replaceChildren()
    credits.forEach((c, i) => {
      if (i) out.append('; ')
      const link = (text: string, href: string | null) => {
        const safe = http(href)
        if (!safe) return document.createTextNode(text)
        const a = document.createElement('a')
        a.href = safe
        a.rel = 'noopener'
        a.target = '_blank'
        a.textContent = text
        return a
      }
      out.append(`${c.role}: `, link(c.title, c.sourceUrl))
      if (c.creator) out.append(' by ', link(c.creator, c.creatorUrl))
      out.append(', ', link(c.licenseLabel, c.licenseUrl))
    })
    out.hidden = credits.length === 0
  }

  #error(message: string) {
    this.#meta = null
    this.#video.removeAttribute('src')
    this.#video.hidden = true
    this.#caption.hidden = true
    if (!this.#box.style.aspectRatio) this.#box.style.aspectRatio = '16 / 9'
    let el = this.#box.querySelector<HTMLElement>('.error')
    if (!el) {
      el = document.createElement('p')
      el.className = 'error'
      el.setAttribute('role', 'alert')
      this.#box.append(el)
    }
    el.textContent = message
    this.dispatchEvent(new CustomEvent('error', { detail: { message }, bubbles: true, composed: true }))
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('video-agent-player'))
  customElements.define('video-agent-player', VideoAgentPlayer)

declare global {
  interface HTMLElementTagNameMap {
    'video-agent-player': VideoAgentPlayer
  }
}
