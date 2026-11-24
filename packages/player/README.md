# netlify-video-agent-player

[![npm](https://img.shields.io/npm/v/netlify-video-agent-player)](https://www.npmjs.com/package/netlify-video-agent-player)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**`<video-agent-player>` puts a published [Video Agent](https://github.com/netlify-labs/video-agent) video on any
page with one tag.** It's a web component with no dependencies, so it works in plain HTML and in any framework.

```html
<script type="module" src="https://<your-site>/player.js"></script>
<video-agent-player src="https://<your-site>/v/<slug>"></video-agent-player>
```

## Why use it

**The problem.** Embedding a video well takes more than a `<video>` tag. You need the right size before it loads so
the page doesn't jump, a poster, a captions track, and credits for any CC BY music it uses.

**The solution.** Give the player a share link. It reads the rest from the link.

| What you get              | How                                                                      |
| ------------------------- | ------------------------------------------------------------------------ |
| One attribute             | `src` is the share link; size, poster, captions and credits come from it |
| No layout shift           | The box has its aspect ratio before anything loads                       |
| A fast first paint        | A blurred placeholder shows until the poster and video arrive            |
| Captions                  | The video's captions track is added and on by default                    |
| Credits handled           | CC BY credits show under the video whenever it has any                   |
| Nothing to install        | Every deployment serves it at `/player.js`                               |
| Yours to style and script | Shadow DOM with `::part()` hooks, `play()` and `pause()`, and DOM events |

## Quick example

```html
<script type="module" src="https://<your-site>/player.js"></script>

<video-agent-player id="launch" src="https://<your-site>/v/<slug>" loop></video-agent-player>

<style>
  video-agent-player {
    max-width: 720px;
  }
  video-agent-player::part(box) {
    border-radius: 12px;
  }
</style>

<script type="module">
  const player = document.getElementById('launch')
  player.addEventListener('loaded', (e) => console.log(e.detail.title, e.detail.durationSec))
  player.addEventListener('ended', () => console.log('watched to the end'))
</script>
```

`video-agent publish` and the SDK's `versions.publish` both return this snippet ready to paste, as `embed`.

## Player, `<video>` or the share page

|                           | `<video-agent-player>` | A plain `<video>` tag | A link to the share page |
| ------------------------- | ---------------------- | --------------------- | ------------------------ |
| Plays on your own page    | Yes                    | Yes                   | No                       |
| Size, poster and captions | From the share link    | You set each one      | Built in                 |
| CC BY credits             | Automatic              | You add them          | Built in                 |
| Setup                     | One tag                | Four URLs and a size  | None                     |

## Install

```html
<!-- From your deployment: nothing to install -->
<script type="module" src="https://<your-site>/player.js"></script>
```

```sh
# Or from npm, for a bundler
npm install netlify-video-agent-player
```

```js
import 'netlify-video-agent-player' // defines <video-agent-player>
```

The import is safe during server rendering: the element only defines itself in a browser.

## Attributes

| Attribute         | What it does                                                                          |
| ----------------- | ------------------------------------------------------------------------------------- |
| `src`             | A video's share link, `https://<your-site>/v/<slug>`. Everything else is read from it |
| `mp4`             | The video file, when you don't use `src`                                              |
| `poster`          | The poster image, with `mp4`                                                          |
| `captions`        | A WebVTT captions file, with `mp4`                                                    |
| `width`, `height` | The video's size, which sets the box's aspect ratio. Default 16:9 until `src` says    |
| `title`           | The video's accessible label, with `mp4`                                              |
| `autoplay`        | Starts playing on load. It also mutes the video, because browsers only autoplay muted |
| `muted`           | Starts muted                                                                          |
| `loop`            | Plays again when it ends                                                              |
| `controls`        | The browser's controls show by default. `controls="false"` hides them                 |

Change `src` at any time and the player loads the new video.

### Without a share link

For a video that isn't published, set the files yourself. Signed URLs from the SDK last 5 to 10 minutes, so set them
right before playing.

```html
<video-agent-player
  mp4="https://example.com/video.mp4"
  poster="https://example.com/poster.jpg"
  captions="https://example.com/captions.vtt"
  width="1920"
  height="1080"
></video-agent-player>
```

## Script it

| Member                 | What it is                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `play()`, `pause()`    | The same as on a `<video>`. `play()` returns a promise                                                                                               |
| `currentTime`, `muted` | Read and write                                                                                                                                       |
| `paused`, `duration`   | Read only                                                                                                                                            |
| `metadata`             | What the player is showing, after `loaded`: `title`, `width`, `height`, `mp4`, `poster`, `captions`, `durationSec`, `credits`, `videoId`, `versionN` |

| Event                                  | When                                                     |
| -------------------------------------- | -------------------------------------------------------- |
| `loaded`                               | The video's details are in. `event.detail` is `metadata` |
| `error`                                | It couldn't load. `event.detail.message` says why        |
| `play`, `pause`, `ended`, `timeupdate` | The same as on a `<video>`                               |

Every event bubbles and crosses the shadow boundary, so you can listen on a parent.

## Style it

The element is `display: block` and never wider than its container. Size it like any block. Inside, three parts are
open to your CSS:

| Part              | What it is                            |
| ----------------- | ------------------------------------- |
| `::part(box)`     | The frame that holds the aspect ratio |
| `::part(video)`   | The `<video>` element                 |
| `::part(credits)` | The credits line under the video      |

```css
video-agent-player::part(credits) {
  font-size: 11px;
  text-align: right;
}
```

In TypeScript, `document.querySelector('video-agent-player')` is typed as `VideoAgentPlayer`. The package also
exports the `PlayerMetadata` and `Credit` types.

## Troubleshooting

| The player shows                                     | Fix                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src must be a Video Agent share link (…/v/<slug>).` | Use the share link from Publish, not the video's page in the app or an MP4. For an MP4, use the `mp4` attribute |
| `This video is not published.`                       | The version was unpublished. Publish it again and use the new share link                                        |
| `This video could not be loaded (HTTP 5xx).`         | The deployment didn't answer. Open the share link in a tab to check it                                          |
| Nothing at all                                       | The script didn't load, or neither `src` nor `mp4` is set                                                       |
| It doesn't autoplay with sound                       | Browsers block that. `autoplay` always starts muted                                                             |
| Captions don't show with `mp4`                       | The captions file must be on the page's own origin; signed URLs send no CORS headers                            |

## Limitations

- **It plays published videos.** `src` only takes a share link. A private video needs `mp4` with a signed URL that
  expires in minutes.
- **The browser's own controls.** There's no custom control bar to theme.
- **Credits can't be hidden.** CC BY requires them, so no attribute turns them off.
- **One captions track,** labelled as English.
- **ES modules only.** Load it with `type="module"` or a bundler.

## FAQ

**Does it work in React, Vue, Svelte or Astro?**
Yes. It's a standard custom element. Import the package once, then use the tag.

**Where do I get the share link?**
Publish a version: the Publish button in the app, `video-agent publish <video>`, or `va.versions.publish(id, n)` in
the SDK.

**What happens when I publish a newer version?**
Each published version has its own share link, so an embed keeps playing the version it points at. To show the
new one, change `src` to the new link.

**Can I track plays?**
Listen for `play`, `ended` and `timeupdate`, and send them to your own analytics. The player sends nothing itself.

**How big is it?**
One small file with no dependencies. It makes one JSON request for the share link, then loads the video.

## License

MIT
