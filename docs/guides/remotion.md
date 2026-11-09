# Experimental: the Remotion engine (bring your own license)

Videos are made with [HyperFrames](https://hyperframes.heygen.com) (HTML, CSS and GSAP, Apache-2.0), and that stays the
default. A deployment can also offer [Remotion](https://www.remotion.dev) (React), which suits 3D, maps and data-heavy
looks. It's off and hidden unless you turn it on, and you need your own Remotion license to use it.

**Remotion isn't open source.** In the app's own words:

> Remotion isn't open source. It's free for individuals, non-profits and companies of up to 3 people, counting the
> people from other teams or contractors you work with on it. Every other company needs a Remotion Company License
> before using it here. For this app that's usually "Remotion for Automators" ($0.01 a render, $100 a month minimum, at
> remotion.pro), and it also covers the Remotion Player the editor uses. Video Agent doesn't buy or check this for you.

| Your organisation                                                                              | License                                                                       |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Individuals, non-profits, companies of up to 3 people (counting collaborators and contractors) | Remotion's Free License                                                       |
| Everyone else                                                                                  | A Remotion Company License (Automators: $0.01 a render, $100 a month minimum) |

This template is MIT and doesn't include Remotion: a run installs it from npm only when `ENGINES` includes it.

**Turning it on takes two steps:**

1. Add `remotion` to `ENGINES` on the project (and, for a Company License, set `VIDEO_AGENT_REMOTION_KEY`). Redeploy.
2. On **Admin**, switch on **Use Remotion** and choose your license. The app records who chose it and when; it never
   stores the key, it only checks that it's set.

**What each render reports.** Remotion counts every render, including the stills a run looks at while it works. Each
one tells remotion.pro the license key (or `free-license`), the kind of event and whether it was production or
development; Remotion keeps that indefinitely. It never sends what's in the video, and for these server-side renders no
domain or IP address. If a key ever shows up in a run's output, rotate it on remotion.pro. The Admin page shows this
month's Remotion render count; reconcile it with remotion.pro, since Video Agent doesn't know how Remotion bills them.

**What works.** Remotion videos are made, revised and played like any other, silent or with a music bed. Editing them
in the browser, sound effects and voice-overs come later. **Turning it off** stops new Remotion videos; existing ones
keep playing. Without `remotion` in `ENGINES`, their new runs fail with `engine_unavailable`.
