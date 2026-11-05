// What anyone turning Remotion on is told, word for word (render-engines plan §7). The Admin dialog, GET
// /api/v1/engines and the CLI's local-mode notice all show this text, so it says the same thing everywhere.
export const REMOTION_LICENSE_NOTICE =
  "Remotion isn't open source. It's free for individuals, non-profits and companies of up to 3 people, counting the people from other teams or contractors you work with on it. Every other company needs a Remotion Company License before using it here. For this app that's usually \"Remotion for Automators\" ($0.01 a render, $100 a month minimum, at remotion.pro), and it also covers the Remotion Player the editor uses. Video Agent doesn't buy or check this for you. Each render tells Remotion which license key was used, what kind of event it was, and whether it was production or development, never what's in the video. If a key ever shows up in a run's output, rotate it on remotion.pro."

/** The two choices, as the dialog's radios label them. */
export const REMOTION_LICENSE_TIERS = {
  free: 'My organisation qualifies for the Free License: renders are reported as "free-license"',
  company:
    'My organisation has a Remotion Company License: renders are reported with VIDEO_AGENT_REMOTION_KEY',
} as const

/** The Admin switch's label. */
export const REMOTION_SWITCH_LABEL = 'Use Remotion (a license is required for most companies)'
