/* global window, document, parent, location, URLSearchParams, requestAnimationFrame, innerWidth, innerHeight, setTimeout, CSS */
// Message bridge for the sandboxed composition preview (plan v2 §7). Injected last into the composition document
// by the /preview edge function. Talks only to its parent, only on its channel (from the URL fragment), and only in
// the shapes the app accepts: ready, time, click{x,y,textId}, error, edits-applied. Takes play, pause, seek and
// apply-edits, and drives the vendored HyperFrames runtime's window.__player.
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
    }
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
