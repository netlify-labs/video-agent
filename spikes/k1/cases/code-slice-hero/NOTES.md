# code-slice-hero: replace by hand (K1)

Not inlined. The block is a WebGL 2 scene, not DOM motion:

- Both headlines are rasterised into canvas textures (`createTextCanvas`), drawn by one instanced WebGL 2 draw
  (`surface.js`) plus a projected-shadow pass (`shadows.js`). No DOM text is on screen, so an editor text op has
  nothing to change unless the beat mirrors hidden `data-va-text` elements into the textures.
- The build is asynchronous (`document.fonts.load("700 420px SliceGeist").then(build)`, with the bundled Geist TTF) and
  registers its own timeline afterwards; `vaBeat` builds synchronously, so the inner timeline would be empty.
- It re-renders on the `hf-seek` window event and from `window.__hyperframes.getVariables()`; a beat script may not use
  `document.`/window globals (contract rule), and the helpers create their canvas with `document.createElement`.
- Size: 24 KB HTML + 18 KB of WebGL helpers, over the 24 KB example cap on its own.

Replacement for the terminal look: a hand-written "code hero" scene: a big monospace headline split into per-character
spans (each line one `data-va-text`), flipped in with a staggered `rotateX` GSAP tween and a sweeping highlight, all DOM.
