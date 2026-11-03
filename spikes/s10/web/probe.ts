// Spike S10: module-worker probe for the API matrix.
;(self as unknown as { postMessage(m: unknown): void }).postMessage('ok')
export {}
