/* Video Agent editing contract v1 (plan v2 §8, §14 rules 18-20): the seek adapter for beats.
 * Each beat is a composition sibling (data-va-beat + data-composition-id) whose timeline is registered here:
 *   vaBeat('intro', (tl, el) => { tl.from(el.querySelector('[data-va-text="title"]'), { opacity: 0 }) })
 * The authored animations live in an inner timeline; the registered (outer) one holds it, time-stretched by
 * data-duration / data-va-authored-duration, so retiming a beat in the editor needs no change to its script.
 * Selectors must stay inside `el` (the beat): beats never reference each other. */
;(function () {
  window.__timelines = window.__timelines || {}
  window.vaBeat = function (id, build) {
    var el = document.querySelector('[data-va-beat="' + id + '"]')
    if (!el) throw new Error('vaBeat: no beat "' + id + '"')
    var authored = parseFloat(el.getAttribute('data-va-authored-duration') || el.getAttribute('data-duration'))
    var duration = parseFloat(el.getAttribute('data-duration'))
    var inner = gsap.timeline()
    build(inner, el)
    var outer = gsap.timeline({ paused: true })
    outer.add(inner, 0)
    if (authored > 0 && duration > 0) inner.timeScale(authored / duration)
    // Hold the last frame to the end of the beat.
    outer.set({}, {}, duration)
    window.__timelines[id] = outer
    return outer
  }
})()
