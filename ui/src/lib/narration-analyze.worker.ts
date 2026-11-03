// The analysis worker for uploaded narration (narration-import.ts): mono 24 kHz samples in, peaks.bin and speech
// spans out, off the page's thread (a ten-minute take is 14.4 million samples).
import { analyzeSamples } from './narration-analyze'

self.onmessage = (e: MessageEvent<{ samples: Float32Array }>) => {
  const out = analyzeSamples(e.data.samples)
  ;(self as unknown as Worker).postMessage(out, [out.peaks.buffer])
}
