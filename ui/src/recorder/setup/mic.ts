// Mic access for the setup panel (plan 2026-11-02 §5.1): the input list, why opening the mic failed, and the short
// per-browser help for a denied mic. Labels are empty until the page has mic permission, so the panel lists again
// after "Check mic". Mock builds only: window.__vaTestMicDevices can supply the list (Playwright, with __vaTestMic).

export interface MicInput {
  deviceId: string
  label: string
}

export type MicProblem = 'denied' | 'missing' | 'busy' | 'insecure' | 'failed'

declare global {
  interface Window {
    /** Mock builds only: stand-in inputs for Playwright. */
    __vaTestMicDevices?: () => MicInput[]
  }
}

export async function listInputs(): Promise<MicInput[]> {
  if (import.meta.env.VITE_MOCK && window.__vaTestMicDevices) return window.__vaTestMicDevices()
  const md = navigator.mediaDevices as MediaDevices | undefined
  if (!md) return []
  const all = await md.enumerateDevices()
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}

/** Why getUserMedia (or the stand-in) failed, from the DOMException name. */
export function micProblem(e: unknown): MicProblem {
  const name = e && typeof e === 'object' && 'name' in e ? String(e.name) : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError')
    return 'denied'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError')
    return 'missing'
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy'
  return 'failed'
}

export type Browser = 'chrome' | 'safari' | 'firefox' | 'other'

export function browserOf(ua: string): Browser {
  if (/firefox|fxios/i.test(ua)) return 'firefox'
  if (/chrome|chromium|crios|edg\//i.test(ua)) return 'chrome'
  if (/safari/i.test(ua)) return 'safari'
  return 'other'
}

const ALLOW: Record<Browser, string> = {
  chrome: 'Click the icon at the left of the address bar, set Microphone to Allow, then Retry.',
  safari: 'In Safari, open Settings for this website (Safari menu), set Microphone to Allow, then Retry.',
  firefox: 'Click the crossed-out mic in the address bar, remove the block, then Retry.',
  other: "Allow the microphone in your browser's site settings, then Retry.",
}

export const PROBLEM_COPY: Record<MicProblem, { title: string; help: (b: Browser, mac: boolean) => string }> =
  {
    denied: {
      title: 'The microphone is blocked',
      help: (b, mac) =>
        ALLOW[b] + (mac ? ' On a Mac, also check System Settings > Privacy & Security > Microphone.' : ''),
    },
    missing: { title: 'No microphone found', help: () => 'Plug one in (or pick another), then Retry.' },
    busy: {
      title: "The microphone can't be opened",
      help: () => 'Another app may be using it. Close that app, then Retry.',
    },
    insecure: {
      title: 'Recording needs a secure page',
      help: () => 'Open the editor over https (or localhost) to use the microphone.',
    },
    failed: { title: "The microphone didn't start", help: () => 'Retry, or pick another microphone.' },
  }
