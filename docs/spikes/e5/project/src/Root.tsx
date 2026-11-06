// Spike E5's compositions: an animated card with a clip (determinism), a local font (offline), a Google-hosted font
// (what offline breaks), and the env a composition can see (REMOTION_ inlining).
import { loadFont } from '@remotion/fonts'
import { AbsoluteFill, Composition, delayRender, continueRender, interpolate, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion'
import { useEffect, useState } from 'react'

const Motion = () => {
  const f = useCurrentFrame()
  const x = interpolate(f, [0, 60], [0, 1200], { extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ background: '#0b0d10' }}>
      <div style={{ position: 'absolute', left: 100 + x, top: 200, width: 300, height: 300, borderRadius: 40, background: 'linear-gradient(135deg,#14b8a6,#f97316)', boxShadow: '0 20px 60px rgba(0,0,0,.5)', transform: `rotate(${f * 3}deg)` }} />
      <OffthreadVideo muted src={staticFile('media/clip.mp4')} style={{ position: 'absolute', left: 100, top: 600, width: 640, height: 360 }} />
      <div style={{ position: 'absolute', left: 900, top: 700, color: 'white', fontSize: 72, fontFamily: 'system-ui', opacity: interpolate(f, [10, 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>Frame {f}</div>
    </AbsoluteFill>
  )
}

const LocalFont = () => {
  const [handle] = useState(() => delayRender('local font'))
  const [loaded, setLoaded] = useState('loading')
  useEffect(() => {
    loadFont({ family: 'SpikeFont', url: staticFile('fonts/spike.ttf') })
      .then(() => {
        console.log('e5:font loaded')
        setLoaded('loaded')
        continueRender(handle)
      })
      .catch((e: unknown) => {
        console.log(`e5:font failed ${String(e)}`)
        setLoaded(`failed: ${String(e)}`)
        continueRender(handle)
      })
  }, [handle])
  return (
    <AbsoluteFill style={{ background: 'white', justifyContent: 'center', alignItems: 'center' }}>
      <div id="state" style={{ fontFamily: 'SpikeFont', fontSize: 120 }}>Org webhooks {loaded}</div>
    </AbsoluteFill>
  )
}

/** What the plan's static scan forbids: a font from a URL. Offline, its delayRender times out. */
const RemoteFont = () => {
  const [handle] = useState(() => delayRender('remote font', { timeoutInMilliseconds: 8000 }))
  useEffect(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=Inter&display=block'
    link.onload = () => {
      void document.fonts.load('48px Inter').then(() => continueRender(handle))
    }
    document.head.appendChild(link)
  }, [handle])
  return <AbsoluteFill style={{ background: 'white', fontFamily: 'Inter', fontSize: 120 }}>Remote</AbsoluteFill>
}

const Env = () => {
  const seen = JSON.stringify({
    test: process.env.REMOTION_TEST ?? null,
    dotenv: process.env.REMOTION_DOTENV ?? null,
    other: process.env.VIDEO_AGENT_REMOTION_KEY ?? null,
  })
  console.log(`e5:env ${seen}`)
  return (
    <AbsoluteFill style={{ background: 'white', fontSize: 40 }}>
      <pre id="env">{seen}</pre>
    </AbsoluteFill>
  )
}

/** The CLI prints a render error but not console output, so this one reports what it sees by throwing. */
const EnvThrow = () => {
  throw new Error(
    `e5:env ${JSON.stringify({ test: process.env.REMOTION_TEST ?? null, dotenv: process.env.REMOTION_DOTENV ?? null, other: process.env.VIDEO_AGENT_REMOTION_KEY ?? null })}`,
  )
}

export const Root = () => (
  <>
    <Composition id="motion" component={Motion} fps={30} width={1920} height={1080} durationInFrames={90} />
    <Composition id="local-font" component={LocalFont} fps={30} width={1920} height={1080} durationInFrames={30} />
    <Composition id="remote-font" component={RemoteFont} fps={30} width={1920} height={1080} durationInFrames={30} />
    <Composition id="env" component={Env} fps={30} width={1920} height={1080} durationInFrames={30} />
    <Composition id="env-throw" component={EnvThrow} fps={30} width={1920} height={1080} durationInFrames={30} />
  </>
)
