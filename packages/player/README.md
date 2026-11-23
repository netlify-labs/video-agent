# netlify-video-agent-player

`<video-agent-player>`: a small web component that plays a published
[Video Agent](https://github.com/netlify-labs/video-agent) video on any page. No dependencies, Shadow DOM.

```sh
npm install netlify-video-agent-player
```

```html
<script type="module">
  import 'netlify-video-agent-player'
</script>
<video-agent-player src="https://<your-site>/v/<slug>"></video-agent-player>
```

Every deployment also serves it, so you can skip the install:

```html
<script type="module" src="https://<your-site>/player.js"></script>
```

`src` is a video's share link. The player reads the size, poster, captions and credits from it, and the box has its
aspect ratio before anything loads, so nothing shifts. Or set `mp4`, `poster`, `captions`, `width` and `height`
yourself. It also takes `autoplay`, `muted`, `loop` and `controls`. CC BY credits show under the video whenever it
has any.

## License

MIT
