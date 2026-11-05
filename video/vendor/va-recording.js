/* Video Agent recording scenes (screen-recording plan §5.3): vaRecording(tl, el) animates a recording scene on its
 * beat's inner timeline. Load it after va-contract.js and call it first in the scene's vaBeat:
 *   vaBeat('add-site', (tl, el) => { vaRecording(tl, el); tl.from(...callout...) })
 * Every time is converted from SOURCE seconds to the beat's AUTHORED time, (s - in) / (out - in) x the slot's authored
 * length, and vaBeat scales authored time to the beat's real length, so a retime needs no change here (never read
 * data-playback-rate: that would scale twice). It reads data-va-camera, data-va-clicks, data-va-redact and the cursor
 * path and locked hidden areas registered by assets/recording/<step>.cursor.js and assets/recording/redact.js. Every
 * entry is parsed and checked; a bad one is skipped with console.warn('va-recording', ...). Deterministic and
 * seek-safe: only GSAP tweens and sets, no timers or clocks. */
;(function () {
  var CSS =
    '.va-recording{position:absolute;inset:0;overflow:hidden}' +
    '.va-recording[data-va-frame="wallpaper"]{background:linear-gradient(135deg,var(--va-color-accent,#14b8a6),var(--va-color-bg,#0b0d10))}' +
    '.va-window{position:absolute;inset:0;overflow:hidden}' +
    '.va-recording[data-va-frame="wallpaper"] .va-window{inset:6%;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.45)}' +
    '.va-stage{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 0}' +
    '.va-stage>video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}' +
    '.va-stage>.va-rec-hold{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;visibility:hidden}' +
    '.va-cursor{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;z-index:3}' +
    '.va-cursor svg{position:absolute;left:-3px;top:-2px;width:28px;height:28px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}' +
    '.va-cursor .va-ring{position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:50%;border:3px solid var(--va-color-accent,#14b8a6);background:rgba(20,184,166,.15)}' +
    '.va-ripple{position:absolute;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;border:3px solid var(--va-color-accent,#14b8a6);visibility:hidden;z-index:2}' +
    '.va-hide{position:absolute;background:var(--va-color-muted,#9aa3ad);visibility:hidden;z-index:4;display:flex;align-items:center;justify-content:center;overflow:hidden}' +
    '.va-hide span{font:600 14px system-ui,sans-serif;color:var(--va-color-bg,#0b0d10);opacity:.8}'
  var ARROW =
    '<svg viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>'

  function warn(beat, field, index) {
    if (window.console) console.warn('va-recording', { beat: beat, field: field, index: index })
  }
  function finite(n) {
    return typeof n === 'number' && isFinite(n)
  }
  function parse(raw, beat, field) {
    if (raw === null || raw === undefined) return []
    try {
      var v = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (Object.prototype.toString.call(v) === '[object Array]') return v
    } catch (e) {}
    warn(beat, field, -1)
    return []
  }
  function frac(n) {
    return finite(n) && n >= 0 && n <= 1
  }

  /** Source seconds `s` as authored seconds in a slot that shows inS..outS over `authored` seconds. */
  function vaRecordingTime(s, inS, outS, authored) {
    return ((s - inS) / (outS - inS)) * authored
  }
  window.vaRecordingTime = vaRecordingTime

  function injectCss() {
    if (document.getElementById('va-recording-css')) return
    var style = document.createElement('style')
    style.id = 'va-recording-css'
    style.textContent = CSS
    document.head.appendChild(style)
  }

  window.vaRecording = function (tl, el) {
    injectCss()
    var beat = el.getAttribute('data-va-beat')
    var rec = el.querySelector('[data-va-recording]')
    var stage = rec && rec.querySelector('.va-stage')
    var video = stage && stage.querySelector('video[data-va-in]')
    if (!video) return warn(beat, 'slot', -1)
    var step = rec.getAttribute('data-va-recording')
    var inS = parseFloat(video.getAttribute('data-va-in'))
    var outS = parseFloat(video.getAttribute('data-va-out'))
    var authored = parseFloat(el.getAttribute('data-va-authored-duration') || el.getAttribute('data-duration'))
    var beatDur = parseFloat(el.getAttribute('data-duration'))
    if (!(outS > inS) || !(authored > 0)) return warn(beat, 'span', -1)
    // A held slot plays in..out over its own (shorter) duration, then the still shows.
    var held = video.getAttribute('data-va-rec-hold') === 'end'
    var slotAuthored = held ? (authored * parseFloat(video.getAttribute('data-duration'))) / beatDur : authored
    if (!(slotAuthored > 0)) slotAuthored = authored
    function A(s) {
      return Math.max(0, Math.min(slotAuthored, vaRecordingTime(s, inS, outS, slotAuthored)))
    }
    function inside(t) {
      return t >= inS - 1e-4 && t <= outS + 1e-4
    }

    // The window the stage moves in: padded wallpaper or full bleed.
    if (!rec.getAttribute('data-va-frame')) rec.setAttribute('data-va-frame', 'wallpaper')
    var win = stage.parentNode
    if (!win.classList || !win.classList.contains('va-window')) {
      win = document.createElement('div')
      win.className = 'va-window'
      rec.insertBefore(win, stage)
      win.appendChild(stage)
    }

    // The zoomed stage overflows its window on purpose (the window clips it).
    stage.setAttribute('data-layout-allow-overflow', '')
    // Camera: x, y (the frame point at the window's centre) and zoom, as percent translate and scale.
    var keys = parse(stage.getAttribute('data-va-camera'), beat, 'camera').filter(function (k, i) {
      var ok =
        k && k.length >= 4 && finite(k[0]) && frac(k[1]) && frac(k[2]) && finite(k[3]) && k[3] >= 1 && k[3] <= 8
      if (!ok) warn(beat, 'camera', i)
      return ok
    })
    keys.sort(function (a, b) {
      return a[0] - b[0]
    })
    function cam(k) {
      return { xPercent: (0.5 - k[1] * k[3]) * 100, yPercent: (0.5 - k[2] * k[3]) * 100, scale: k[3] }
    }
    var first = keys[0] || [inS, 0.5, 0.5, 1]
    tl.set(stage, cam(first), 0)
    for (var i = 1; i < keys.length; i++) {
      var a = keys[i - 1]
      var b = keys[i]
      var to = cam(b)
      to.ease = typeof b[4] === 'string' ? b[4] : 'none'
      to.duration = Math.max(0, A(b[0]) - A(a[0]))
      tl.to(stage, to, A(a[0]))
    }

    // Cursor: an arrow (trace), the highlight ring (inferred) or none; it follows the path linearly between points.
    var cursorEl = stage.querySelector('.va-cursor')
    var style = cursorEl ? cursorEl.getAttribute('data-va-cursor') || 'none' : 'none'
    if (cursorEl) {
      var size = parseFloat(cursorEl.getAttribute('data-va-cursor-size'))
      if (!(size > 0)) size = 1
      cursorEl.innerHTML = style === 'smooth' ? ARROW : style === 'highlight' ? '<div class="va-ring"></div>' : ''
      var registry = window.__vaCursor || {}
      var points = (style === 'none' ? [] : parse(registry[cursorEl.getAttribute('data-va-path') || step], beat, 'cursor'))
        .filter(function (p, i) {
          var ok = p && p.length === 3 && finite(p[0]) && frac(p[1]) && frac(p[2]) && inside(p[0])
          if (!ok) warn(beat, 'cursor', i)
          return ok
        })
      if (!points.length) tl.set(cursorEl, { autoAlpha: 0 }, 0)
      else {
        tl.set(cursorEl, { autoAlpha: 1, scale: size, left: points[0][1] * 100 + '%', top: points[0][2] * 100 + '%' }, 0)
        for (var j = 1; j < points.length; j++) {
          var p0 = points[j - 1]
          var p1 = points[j]
          tl.to(
            cursorEl,
            { left: p1[1] * 100 + '%', top: p1[2] * 100 + '%', duration: Math.max(0, A(p1[0]) - A(p0[0])), ease: 'none' },
            A(p0[0]),
          )
        }
      }
    }

    // Click ripples: a ring that scales 0.6 -> 1.6 and fades over 0.35 s.
    if (style !== 'none')
      parse(stage.querySelector('[data-va-clicks]') && stage.querySelector('[data-va-clicks]').getAttribute('data-va-clicks'), beat, 'clicks').forEach(
        function (c, i) {
          if (!(c && c.length === 3 && finite(c[0]) && frac(c[1]) && frac(c[2]) && inside(c[0]))) return warn(beat, 'clicks', i)
          var r = document.createElement('div')
          r.className = 'va-ripple'
          r.style.left = c[1] * 100 + '%'
          r.style.top = c[2] * 100 + '%'
          stage.appendChild(r)
          tl.set(r, { autoAlpha: 0 }, 0)
          tl.fromTo(r, { scale: 0.6, autoAlpha: 0.9 }, { scale: 1.6, autoAlpha: 0, duration: 0.35, ease: 'power1.out', immediateRender: false }, A(c[0]))
        },
      )

    // Hidden areas: the recording's locked ones (redact.js) and the scene's own, stepped from key to key (no easing,
    // so a box never lags a scrolling field), hidden outside start..end and for a zero-size key.
    var redactEl = stage.querySelector('[data-va-redact]')
    var entries = parse(window.__vaRedact, beat, 'locked').concat(
      parse(redactEl && redactEl.getAttribute('data-va-redact'), beat, 'redact'),
    )
    entries.forEach(function (e, i) {
      var okKeys =
        e &&
        finite(e.start) &&
        finite(e.end) &&
        Object.prototype.toString.call(e.boxes) === '[object Array]' &&
        e.boxes.length &&
        e.boxes.every(function (k) {
          return k && k.length === 5 && finite(k[0]) && frac(k[1]) && frac(k[2]) && frac(k[3]) && frac(k[4])
        })
      if (!okKeys) return warn(beat, 'redact', i)
      if (e.end <= inS || e.start >= outS) return
      var box = document.createElement('div')
      box.className = 'va-hide'
      box.innerHTML = '<span>Hidden</span>'
      stage.appendChild(box)
      var times = [e.start, e.end]
      e.boxes.forEach(function (k) {
        times.push(k[0])
      })
      times = times
        .map(function (t) {
          return Math.max(inS, Math.min(outS, t))
        })
        .sort(function (a, b) {
          return a - b
        })
      tl.set(box, { autoAlpha: 0 }, 0)
      times.forEach(function (t, n) {
        if (n && t === times[n - 1]) return
        var k = e.boxes[0]
        e.boxes.forEach(function (x) {
          if (x[0] <= t + 1e-9) k = x
        })
        var on = t >= e.start - 1e-9 && t < e.end - 1e-9 && k[3] > 0 && k[4] > 0
        tl.set(
          box,
          { autoAlpha: on ? 1 : 0, left: k[1] * 100 + '%', top: k[2] * 100 + '%', width: k[3] * 100 + '%', height: k[4] * 100 + '%' },
          A(t),
        )
      })
    })

    // The held out frame, from the slot's end to the scene's.
    var hold = stage.querySelector('img.va-rec-hold')
    if (hold) {
      tl.set(hold, { autoAlpha: 0 }, 0)
      if (held) tl.set(hold, { autoAlpha: 1 }, slotAuthored)
    }
    // The tweens never run past the scene: the last one ends at most at the slot's authored end.
    tl.set({}, {}, slotAuthored)
  }
})()
