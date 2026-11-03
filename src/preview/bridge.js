/* global window, document, parent, location, URLSearchParams, requestAnimationFrame, innerWidth, innerHeight, setTimeout, CSS */
// Message bridge for the sandboxed composition preview (plan v2 §7). Injected last into the composition document
// by the /preview edge function. Talks only to its parent, only on its channel (from the URL fragment), and only in
// the shapes the app accepts: ready, time, click{x,y,textId}, error, edits-applied, mix-applied. Takes play, pause,
// seek, apply-edits and mix, and drives the vendored HyperFrames runtime's window.__player.
;(() => {
  const channel = new URLSearchParams(location.hash.slice(1)).get('ch')
  if (!channel) return
  const post = (m) => parent.postMessage(Object.assign({ channel }, m), '*')
  const player = () => window.__player
  let last = -1
  const tick = () => {
    const p = player()
    if (p) {
      const t = p.getTime()
      if (Math.abs(t - last) > 0.02) {
        last = t
        post({ type: 'time', time: t })
      }
    }
    requestAnimationFrame(tick)
  }
  // mix{tracks} (docs/plans/2026-11-02-record-your-own-voiceover.md §5.4): per-role level, mute and volume lane for
  // the narration audition. Roles follow the contract's audioOf: data-va-audio, else data-va-voice is voice, a music
  // or narration layer is that, the rest sfx. It writes the attributes the runtime already plays (data-volume, and
  // the volume lane of data-automation, which the runtime interpolates on the composition clock, so keyframes come
  // once per change), from each element's own values kept in data-va-mix-*: every mix starts from the composition's
  // levels, and an empty one restores them. A role's gain multiplies the element's level (muted is 0), capped at 4.
  const ROLES = ['music', 'voice', 'sfx', 'narration']
  const MAX_LANE_POINTS = 512
  const roleOf = (el) => {
    const layer = el.getAttribute('data-va-layer')
    const role =
      el.getAttribute('data-va-audio') ??
      (el.getAttribute('data-va-voice') !== null
        ? 'voice'
        : layer === 'music' || layer === 'narration'
          ? layer
          : 'sfx')
    return ROLES.indexOf(role) >= 0 ? role : 'sfx'
  }
  const finite = (n) => typeof n === 'number' && isFinite(n)
  const validLane = (lane) =>
    Array.isArray(lane) &&
    lane.length <= MAX_LANE_POINTS &&
    lane.every(
      (p, i) =>
        p &&
        finite(p.t) &&
        finite(p.v) &&
        p.t >= 0 &&
        p.v >= 0 &&
        p.v <= 4 &&
        (i === 0 || p.t > lane[i - 1].t),
    )
  /** The element's own automation JSON with its volume lane replaced (array), removed (null) or kept (anything else). */
  const withLane = (own, lane) => {
    if (lane !== null && !validLane(lane)) return own
    let auto
    try {
      auto = own ? JSON.parse(own) : {}
    } catch {
      return own
    }
    if (!auto || typeof auto !== 'object') return own
    const lanes = (Array.isArray(auto.lanes) ? auto.lanes : []).filter((l) => !l || l.target !== 'volume')
    if (lane) lanes.push({ target: 'volume', points: lane.map((p) => ({ t: p.t, v: p.v })) })
    return lanes.length ? JSON.stringify(Object.assign({}, auto, { version: 1, lanes })) : ''
  }
  const mix = (tracks) => {
    let applied = 0
    for (const el of document.querySelectorAll('audio[id]')) {
      if (el.getAttribute('data-va-mix-volume') === null) {
        el.setAttribute('data-va-mix-volume', el.getAttribute('data-volume') ?? '1')
        el.setAttribute('data-va-mix-automation', el.getAttribute('data-automation') ?? '')
      }
      const level = Number(el.getAttribute('data-va-mix-volume'))
      const own = el.getAttribute('data-va-mix-automation') || ''
      const t = tracks[roleOf(el)]
      const m = t && typeof t === 'object' ? t : {}
      const gain = m.muted === true ? 0 : finite(m.gain) ? Math.min(4, Math.max(0, m.gain)) : 1
      const volume = Math.min(4, (isFinite(level) && level >= 0 ? level : 1) * gain)
      el.setAttribute('data-volume', String(Math.round(volume * 1000) / 1000))
      const auto = 'lane' in m ? withLane(own, m.lane) : own
      if (auto) el.setAttribute('data-automation', auto)
      else el.removeAttribute('data-automation')
      applied++
    }
    post({ type: 'mix-applied', count: applied })
  }
  window.addEventListener('message', (e) => {
    if (e.source !== parent) return
    const m = e.data
    const p = player()
    if (!m || typeof m !== 'object' || m.channel !== channel || !p) return
    if (m.type === 'play') p.play()
    else if (m.type === 'pause') p.pause()
    else if (m.type === 'seek' && typeof m.time === 'number' && isFinite(m.time)) p.seek(Math.max(0, m.time))
    else if (m.type === 'apply-edits' && Array.isArray(m.edits)) {
      let applied = 0
      for (const ed of m.edits.slice(0, 500)) {
        const el =
          ed && typeof ed.id === 'string'
            ? document.querySelector('[data-va-text="' + CSS.escape(ed.id) + '"]') ||
              document.getElementById(ed.id)
            : null
        if (el && typeof ed.text === 'string') {
          el.textContent = ed.text // text nodes only, never HTML
          applied++
        }
      }
      post({ type: 'edits-applied', count: applied })
    } else if (m.type === 'mix' && m.tracks && typeof m.tracks === 'object') mix(m.tracks)
  })
  document.addEventListener(
    'click',
    (ev) => {
      // Contract text is keyed by data-va-text (plan v2 §8); anything else reports its element id.
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-va-text]') : null
      const el = t || (ev.target && ev.target.closest ? ev.target.closest('[id]') : null)
      const key = t ? t.getAttribute('data-va-text') : el ? el.id : null
      post({
        type: 'click',
        x: Math.min(1, Math.max(0, ev.clientX / innerWidth)),
        y: Math.min(1, Math.max(0, ev.clientY / innerHeight)),
        textId: key ? String(key).slice(0, 200) : null,
      })
    },
    true,
  )
  window.addEventListener('error', (e) =>
    post({ type: 'error', message: String(e.message || 'error').slice(0, 300) }),
  )
  let waited = 0
  const waitReady = () => {
    const p = player()
    if (window.__playerReady && p) {
      post({ type: 'ready', duration: p.getDuration() })
      requestAnimationFrame(tick)
    } else if ((waited += 50) < 20000) setTimeout(waitReady, 50)
    else post({ type: 'error', message: "The composition didn't start." })
  }
  waitReady()
})()
