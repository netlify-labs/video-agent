import { z } from 'zod'

const text = z.object({ text: z.string(), label: z.string().nullable() })
const media = z.object({
  kind: z.enum(['image', 'video']),
  src: z.string(),
  fit: z.string().nullable(),
  label: z.string().nullable(),
})
const voice = z.object({
  id: z.string(),
  src: z.string(),
  start: z.number(),
  duration: z.number(),
  volume: z.number(),
  muted: z.boolean(),
  /** The line as the editor shows it, and as it was spoken: they differ when it needs re-voicing. */
  line: z.string().nullable(),
  spoken: z.string().nullable(),
})
export const beatSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().nullable(),
  duration: z.number(),
  authoredDuration: z.number(),
  texts: z.record(z.string(), text),
  media: z.record(z.string(), media),
  voice: voice.nullable(),
})
export const vaSchema = z.object({
  contract: z.literal(1),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.literal(30),
  colors: z.record(z.string(), z.string()),
  layers: z.array(z.object({ id: z.string(), label: z.string().nullable() })),
  beats: z.array(beatSchema),
  audio: z.object({
    music: z
      .object({
        id: z.string(),
        label: z.string().nullable(),
        src: z.string(),
        volume: z.number(),
        muted: z.boolean(),
      })
      .nullable(),
  }),
})
export type VaProps = z.infer<typeof vaSchema>
export type VaBeat = z.infer<typeof beatSchema>
