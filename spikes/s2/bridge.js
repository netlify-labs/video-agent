// Bridge injected last into the sandboxed composition document. Talks only to its parent, only on its channel, and
// only in the shapes the app accepts: ready, time, click{x,y,textId}, error, edits-applied. Takes play, pause, seek,
// apply-edits. Drives the vendored runtime's window.__player (play, pause, seek, getTime, getDuration).
;(() => {
  const channel = new URLSearchParams(location.hash.slice(1)).get('ch')
  const post = (m) => parent.postMessage(Object.assign({ channel }, m), '*')
  const player = () => window.__player
  let last = -1
  const tick = () => {
    const p = player()
    if (p) {
      const t = p.getTime()
      if (Math.abs(t - last) > 0.01) {
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
    else if (m.type === 'seek' && typeof m.time === 'number') p.seek(m.time)
    else if (m.type === 'apply-edits' && Array.isArray(m.edits)) {
      for (const ed of m.edits) {
        const el = document.getElementById(String(ed.id))
        if (el) el.textContent = String(ed.text) // text nodes only, never HTML
      }
      post({ type: 'edits-applied', count: m.edits.length })
    } else if (m.type === 'probe') {
      // Spike only: what the canary saw and whether subresources loaded.
      const img = document.getElementById('logo')
      const vid = document.getElementById('clip')
      const outro = document.getElementById('outro-text')
      post({
        type: 'probe',
        canary: window.__canary,
        title: document.getElementById('title').textContent,
        logoLoaded: !!img && img.complete && img.naturalWidth > 0,
        clipReady: vid ? vid.readyState : -1,
        nested: outro ? outro.textContent.trim() : null,
        bg: getComputedStyle(document.body).backgroundImage,
      })
    }
  })
  document.addEventListener(
    'click',
    (ev) => {
      const el = ev.target && ev.target.closest ? ev.target.closest('[id]') : null
      post({
        type: 'click',
        x: ev.clientX / innerWidth,
        y: ev.clientY / innerHeight,
        textId: el ? el.id : null,
      })
    },
    true,
  )
  window.addEventListener('error', (e) => post({ type: 'error', message: String(e.message).slice(0, 200) }))
  const waitReady = () => {
    const p = player()
    if (window.__playerReady && p) {
      post({ type: 'ready', duration: p.getDuration() })
      requestAnimationFrame(tick)
    } else setTimeout(waitReady, 50)
  }
  waitReady()
})()
