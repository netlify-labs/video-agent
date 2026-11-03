// The recorder's monitor mix (docs/plans/2026-11-02-record-your-own-voiceover.md §5.3, §2.2 step 2): what the record
// flow (va-2qq.4.11) imports to play the draft's stems in the capture's AudioContext while a take records.
export * from './stems'
export * from './stem-monitor'
export * from './loaders'
export { useStemMonitor, type UseStemMonitorInput } from './use-stem-monitor'
