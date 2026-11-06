// LOCKED. props.json's shape: editing contract v1 (Remotion), Phase 2. Imports only zod, so the service can generate
// a JSON Schema from it (scripts/gen-remotion-locked.ts) without Remotion installed.
import { z } from 'zod'

const id = z.string().regex(/^[a-z0-9-]+$/)
const text = z.object({ text: z.string().max(500), label: z.string().nullable() })
const media = z.object({
  kind: z.enum(['image', 'video']),
  src: z.string().regex(/^assets\/media\/[A-Za-z0-9_.-]+$/),
  fit: z.enum(['cover', 'contain']).nullable(),
  label: z.string().nullable(),
  /** A clip plays its own sound only when this is true; otherwise it's muted. */
  hasAudio: z.boolean().optional(),
})
export const beatSchema = z.object({
  id,
  label: z.string().nullable(),
  /** Seconds. */
  duration: z.number().min(0.5).max(120),
  authoredDuration: z.number().min(0.5).max(120),
  texts: z.record(z.string().regex(/^[a-z0-9-]+$/), text),
  media: z.record(z.string().regex(/^[a-z0-9-]+$/), media),
  /** Per-beat voice and effects arrive in Phase 4. */
  voice: z.null(),
  sfx: z.tuple([]),
})
export const vaSchema = z.object({
  contract: z.literal(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.literal(30),
  colors: z.record(z.string().regex(/^[a-z0-9-]+$/), z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)),
  layers: z.array(z.object({ id, label: z.string().nullable() })),
  beats: z.array(beatSchema).min(1),
  audio: z.object({
    music: z
      .object({
        id,
        label: z.string().nullable(),
        src: z.string().regex(/^assets\/(media|music)\/[A-Za-z0-9_.-]+$/),
        volume: z.number().min(0).max(4),
        muted: z.boolean(),
        /** Seconds. */
        fadeIn: z.number().min(0).max(10),
        fadeOut: z.number().min(0).max(10),
      })
      .nullable(),
  }),
})
export type VaProps = z.infer<typeof vaSchema>
export type VaBeat = z.infer<typeof beatSchema>
