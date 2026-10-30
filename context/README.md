# context/

Everything in this folder is read by the agent at the start of every video. Fill it in once and every
video follows it. Commit and push to change it; each run uses the context from the production deploy
it starts from.

| File | What to put there |
| --- | --- |
| `BRAND.md` | Your brand: colors (hex), typography, logo usage, tone of voice, motion style, do's and don'ts. |
| `PRODUCT.md` (optional) | What your company and products are, names to use, claims you may and may not make. |
| `brand.json` | Machine-readable basics the web app also uses for its theme: `name`, `primaryColor`, `logo`. |
| `assets/` | Logos (SVG preferred) and fonts (WOFF2) the agent may use. Only add files you have the rights to. |

Keep it short and concrete. The agent follows rules better than adjectives: "headlines are 96 px, white on
#0b0d10, never more than 6 words" beats "bold and modern".

The web app's setup page shows a warning while this folder still has the neutral default.
