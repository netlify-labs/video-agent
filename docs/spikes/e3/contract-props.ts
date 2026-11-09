// Editing contract v1 over props.json (render-engines plan §5.2): the same Composition and captions as
// src/lib/contract.ts gives for a HyperFrames index.html, computed from data instead of markup. Pure TS (no React,
// no Remotion), so it's what src/lib/contract-remotion.ts would start from in Phase 3.
import {
  ContractError,
  MAX_NARRATION,
  MAX_VOLUME,
  normalizeLine,
  type AudioTrack,
  type Composition,
  type EditOp,
  type Summary,
} from '../../../app/server/lib/contract.js'
import { frames, layout, sec } from './project/src/va/layout.js'
import type { VaProps } from './project/src/va/schema.js'

const clone = <T>(x: T): T => structuredClone(x)

/** The props a HyperFrames composition carries, so a paired fixture describes the same video. */
export function propsFromComposition(
  c: Composition,
  size: { width: number; height: number },
  spoken: Record<string, string>,
): VaProps {
  const music = c.audio.find((a) => a.role === 'music') ?? null
  const voices = new Map(c.audio.filter((a) => a.role === 'voice').map((a) => [a.beat, a]))
  return {
    contract: 1,
    width: size.width,
    height: size.height,
    fps: 30,
    colors: { ...c.colors },
    layers: c.layers.filter((id) => id !== music?.id).map((id) => ({ id, label: null })),
    beats: c.beats.map((b) => {
      const track = voices.get(b.id)
      return {
        id: b.id,
        label: b.label,
        duration: b.duration,
        authoredDuration: b.authoredDuration,
        texts: Object.fromEntries(b.texts.map((t) => [t.id, { text: t.text, label: t.label }])),
        media: Object.fromEntries(
          b.media.map((m) => [m.slot, { kind: m.kind, src: m.src, fit: m.fit, label: m.label }]),
        ),
        voice: b.voice
          ? {
              ...b.voice,
              volume: track?.volume ?? 1,
              muted: track?.muted ?? false,
              line: spoken[b.id] ?? null,
              spoken: spoken[b.id] ?? null,
            }
          : null,
      }
    }),
    audio: {
      music: music
        ? { id: music.id, label: music.label, src: music.src, volume: music.volume, muted: music.muted }
        : null,
    },
  }
}

/** The editor's model of a props.json, field for field what contract.ts's read gives. */
export function readProps(p: VaProps): Composition {
  const lay = layout(p.beats)
  const music = p.audio.music
  const audio: AudioTrack[] = [
    ...(music ? [{ id: music.id, role: 'music' as const, label: music.label, src: music.src, volume: music.volume, muted: music.muted, beat: null }] : []),
    ...p.beats.flatMap((b) =>
      b.voice
        ? [{ id: b.voice.id, role: 'voice' as const, label: null, src: b.voice.src, volume: b.voice.volume, muted: b.voice.muted, beat: b.id }]
        : [],
    ),
  ]
  return {
    duration: lay.total,
    colors: { ...p.colors },
    beats: p.beats.map((b, i) => ({
      id: b.id,
      label: b.label,
      start: lay.beats[i]?.start ?? 0,
      duration: lay.beats[i]?.duration ?? 0,
      authoredDuration: b.authoredDuration,
      texts: Object.entries(b.texts).map(([id, t]) => ({ id, text: t.text, label: t.label })),
      media: Object.entries(b.media).map(([slot, m]) => ({ slot, label: m.label, kind: m.kind, src: m.src, beat: b.id, fit: m.fit })),
      voice: b.voice ? { id: b.voice.id, src: b.voice.src, start: b.voice.start, duration: b.voice.duration } : null,
    })),
    layers: [...(music ? [music.id] : []), ...p.layers.map((l) => l.id)],
    audio,
    narration: p.beats.flatMap((b) =>
      b.voice?.line != null ? [{ beat: b.id, text: b.voice.line, revoice: b.voice.line !== b.voice.spoken }] : [],
    ),
  }
}

/** contract.ts's syncCaptions over the Composition, not the markup: the piece contract-core.ts would share. */
export function syncCaptions(c: Composition, summary: Summary): Summary {
  if (!summary.captions) return summary
  const beats = new Map(c.beats.map((b) => [b.id, b]))
  const texts = new Map(c.beats.flatMap((b) => b.texts.map((x) => [x.id, x.text] as const)))
  const captions = summary.captions
    .filter((x) => !x.beat || beats.has(x.beat))
    .map((x) => {
      const b = x.beat ? beats.get(x.beat) : undefined
      if (!b || x.beatStart === undefined || x.beatEnd === undefined) return x
      const k = x.voice ? 1 : b.duration / b.authoredDuration
      return {
        ...x,
        start: frames(b.start + x.beatStart * k),
        end: frames(Math.min(b.start + b.duration, b.start + x.beatEnd * k)),
        text: (x.textId && texts.get(x.textId)) || x.text,
      }
    })
    .sort((a, b) => a.start - b.start)
  return { ...summary, captions }
}

/** src/registry.ts as engine.ts check would generate it from props.json. */
export function registryFor(p: VaProps): string {
  const name = (id: string, kind: string) => `${kind}_${id.replace(/-/g, '_')}`
  return [
    '// GENERATED from props.json by engine.ts check. Do not edit.',
    "import type { ComponentType } from 'react'",
    ...p.beats.map((b) => `import ${name(b.id, 'beat')} from './beats/${b.id}'`),
    ...p.layers.map((l) => `import ${name(l.id, 'layer')} from './layers/${l.id}'`),
    '',
    `export const beats: Record<string, ComponentType> = { ${p.beats.map((b) => `'${b.id}': ${name(b.id, 'beat')}`).join(', ')} }`,
    `export const layers: Record<string, ComponentType> = { ${p.layers.map((l) => `'${l.id}': ${name(l.id, 'layer')}`).join(', ')} }`,
    '',
  ].join('\n')
}

/**
 * applyEdits on props.json: the new props and the files it removes (a deleted beat's component and its assets).
 * Same refusals and messages as contract.ts, so the editor can't tell the engines apart.
 */
export function applyOps(
  props: VaProps,
  summary: Summary,
  ops: EditOp[],
  opts: { palette?: string[] } = {},
): { props: VaProps; summary: Summary; composition: Composition; removed: string[] } {
  const p = clone(props)
  const removed: string[] = []
  const beat = (id: string) => {
    const b = p.beats.find((x) => x.id === id)
    if (!b) throw new ContractError([`There's no beat "${id}".`])
    return b
  }
  for (const op of ops)
    switch (op.op) {
      case 'text': {
        const b = p.beats.find((x) => op.id in x.texts)
        const t = b?.texts[op.id]
        if (!t) throw new ContractError([`There's no text "${op.id}".`])
        if (op.text.length > 500) throw new ContractError(['Keep text under 500 characters.'])
        t.text = op.text
        break
      }
      case 'retime': {
        const dur = frames(op.duration)
        if (!(dur >= 0.5 && dur <= 120)) throw new ContractError(['A beat lasts between 0.5 and 120 seconds.'])
        beat(op.beat).duration = dur
        break
      }
      case 'reorder': {
        const ids = p.beats.map((b) => b.id)
        if (op.order.length !== ids.length || [...op.order].sort().join() !== [...ids].sort().join())
          throw new ContractError(['A reorder must list every beat once.'])
        p.beats = op.order.map(beat)
        break
      }
      case 'delete': {
        if (p.beats.length <= 1) throw new ContractError(["The last beat can't be deleted."])
        beat(op.beat)
        p.beats = p.beats.filter((b) => b.id !== op.beat)
        removed.push(`src/beats/${op.beat}.tsx`, `assets/beats/${op.beat}/`)
        break
      }
      case 'color': {
        const value = op.value.trim().toLowerCase()
        const palette = (opts.palette ?? []).map((c) => c.toLowerCase())
        if (palette.length ? !palette.includes(value) : !/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(value))
          throw new ContractError([`${op.value} isn't in the brand palette.`])
        if (!(op.role in p.colors)) throw new ContractError([`There's no colour role "${op.role}".`])
        p.colors[op.role] = value
        break
      }
      case 'media': {
        const m = p.beats.map((b) => b.media[op.slot]).find(Boolean)
        if (!m) throw new ContractError([`There's no media slot "${op.slot}".`])
        if (m.kind !== op.kind)
          throw new ContractError([`Slot "${op.slot}" takes ${m.kind} media, not ${op.kind}.`])
        if (!/^assets\/media\/[A-Za-z0-9_.-]+$/.test(op.src)) throw new ContractError(['Media comes from assets/media/.'])
        m.src = op.src
        m.fit = op.fit
        break
      }
      case 'audio': {
        const music = p.audio.music?.id === op.id ? p.audio.music : null
        const voice = p.beats.map((b) => b.voice).find((v) => v?.id === op.id) ?? null
        const track = music ?? voice
        if (!track) throw new ContractError([`There's no audio "${op.id}".`])
        if (op.src !== undefined && op.src !== track.src) {
          if (!/^assets\/media\/[A-Za-z0-9_.-]+$/.test(op.src)) throw new ContractError(['Audio comes from assets/media/.'])
          track.src = op.src
        }
        const volume = op.volume ?? track.volume
        if (!(volume >= 0 && volume <= MAX_VOLUME)) throw new ContractError([`Volume goes from 0 to ${MAX_VOLUME}.`])
        track.volume = Math.round(volume * 100) / 100
        if (op.muted !== undefined) track.muted = op.muted
        break
      }
      case 'voice': {
        const v = beat(op.beat).voice
        if (!v || v.spoken == null) throw new ContractError([`Beat "${op.beat}" has no narration to change.`])
        const text = normalizeLine(op.text)
        if (!text) throw new ContractError(['A narration line needs some words.'])
        if (text.length > MAX_NARRATION)
          throw new ContractError([`Keep a narration line under ${MAX_NARRATION} characters.`])
        v.line = text
        break
      }
    }
  const composition = readProps(p)
  // The model-level rules contract.ts's validate checks after every edit (the markup-only ones have no props form).
  const problems = composition.beats.flatMap((b) =>
    b.voice && b.voice.start + b.voice.duration > b.duration + 0.5 / 30
      ? [`Beat "${b.id}" is ${sec(b.duration)}s but its voice-over runs to ${sec(b.voice.start + b.voice.duration)}s; make the beat longer.`]
      : [],
  )
  if (problems.length) throw new ContractError(problems)
  return { props: p, summary: syncCaptions(composition, summary), composition, removed }
}
