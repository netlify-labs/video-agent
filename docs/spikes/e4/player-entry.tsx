// The Remotion preview page (render-engines plan §4.4): @remotion/player mounting the E3 composition, speaking the
// bridge protocol of src/preview/bridge.js. Sends ready, time, error and edits-applied; takes play, pause, seek and
// apply-edits (new props). Every CSP violation is reported to the parent as an error with its directive.
import { Player, type PlayerRef } from '@remotion/player'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import initial from '../e3/project/props.json'
import { layout } from '../e3/project/src/va/layout'
import type { VaProps } from '../e3/project/src/va/schema'
import { VaVideo } from '../e3/project/src/va/Video'

const hash = new URLSearchParams(location.hash.slice(1))
const channel = hash.get('ch') ?? ''
// The Player keeps a pool of shared <audio> tags with a silent data: source; tags=0 turns the pool off.
const tags = hash.has('tags') ? Number(hash.get('tags')) : undefined
const post = (m: Record<string, unknown>) => parent.postMessage({ channel, ...m }, '*')
document.addEventListener('securitypolicyviolation', (e) => {
  post({
    type: 'error',
    csp: { directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample.slice(0, 80) },
  })
})
window.addEventListener('error', (e) => post({ type: 'error', message: String(e.message) }))
window.addEventListener('unhandledrejection', (e) => post({ type: 'error', message: String(e.reason) }))

const App = () => {
  const ref = useRef<PlayerRef>(null)
  const [props, setProps] = useState(initial as VaProps)
  const applied = useRef<number | null>(null)
  useEffect(() => {
    const p = ref.current
    if (!p) return
    const time = () => post({ type: 'time', time: p.getCurrentFrame() / 30 })
    p.addEventListener('frameupdate', time)
    p.addEventListener('seeked', time)
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { channel?: string; type?: string; time?: number; props?: VaProps; rev?: number }
      if (e.source !== parent || m.channel !== channel) return
      if (m.type === 'play') p.play()
      if (m.type === 'pause') p.pause()
      if (m.type === 'seek' && typeof m.time === 'number') p.seekTo(Math.round(m.time * 30))
      if (m.type === 'apply-edits' && m.props) {
        applied.current = m.rev ?? 0
        setProps(m.props)
      }
    }
    window.addEventListener('message', onMessage)
    requestAnimationFrame(() =>
      post({ type: 'ready', duration: p.getContainerNode() ? layout(props.beats).total : 0 }),
    )
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (applied.current === null) return
    const rev = applied.current
    applied.current = null
    requestAnimationFrame(() => requestAnimationFrame(() => post({ type: 'edits-applied', rev })))
  }, [props])
  return (
    <Player
      ref={ref}
      component={VaVideo}
      inputProps={props}
      durationInFrames={Math.max(1, layout(props.beats).totalFrames)}
      fps={30}
      compositionWidth={1920}
      compositionHeight={1080}
      style={{ width: '100vw', height: '100vh' }}
      acknowledgeRemotionLicense
      {...(tags === undefined ? {} : { numberOfSharedAudioTags: tags })}
    />
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
