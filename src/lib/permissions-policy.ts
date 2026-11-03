// Microphone Permissions-Policy (record-your-own-voice-over plan §8). The app records voice-over takes, so its pages
// (netlify.toml, static responses) allow the microphone for the app's own origin. Pages served by edge functions
// (the public share page, which is also the embed player, and the composition preview) never get it, and set it
// themselves rather than rely on netlify.toml headers reaching edge responses. No imports: the edge functions bundle it.

/** The app's pages (netlify.toml). */
export const APP_PERMISSIONS_POLICY = 'microphone=(self)'
/** Share, embed, public and preview pages. */
export const EDGE_PERMISSIONS_POLICY = 'microphone=()'

/** The headers with the microphone denied, for an edge function's document responses. */
export const denyMicrophone = (headers: Record<string, string>): Record<string, string> => ({
  ...headers,
  'permissions-policy': EDGE_PERMISSIONS_POLICY,
})
