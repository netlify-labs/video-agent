# context/

Everything in this folder is read by the agent at the start of every video. Fill it in once and every
video follows it. Commit and push to change it; each run uses the context from the production deploy
it starts from.

| File                    | What to put there                                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAND.md`              | Your brand: colors (hex), typography, logo usage, tone of voice, motion style, do's and don'ts.                                                                                                                                                                  |
| `PRODUCT.md` (optional) | What your company and products are, names to use, claims you may and may not make.                                                                                                                                                                               |
| `brand.json`            | Ships with neutral defaults. The web app uses it for its name and accent: `{ "name": "Acme Video", "primaryColor": "#ff5a1f", "logo": "assets/logo.svg" }`. Remove `"default": true` here (and the `video-agent:default` line in `BRAND.md`) once they're yours. |
| `assets/`               | Logos (SVG preferred) and fonts (WOFF2) the agent may use. Only add files you have the rights to.                                                                                                                                                                |

Keep it short and concrete. The agent follows rules better than adjectives: "headlines are 96 px, white on
#0b0d10, never more than 6 words" beats "bold and modern".

The web app's setup page shows a warning while this folder still has the neutral default.
