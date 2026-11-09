// New video's WebMCP tools (va-qago.2): fill the form the person sees, and create the video (it spends credits, so the
// person confirms in the app first). Inputs follow the MCP server's create_video (app/server/mcp.ts) where they overlap.
import { fail, ok, type InputSchema, type PropertySchema } from './tools'
import { useWebMcpTool } from './useWebMcpTool'

const ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const
const SOUNDS = ['silent', 'music', 'music_sfx'] as const

export interface VideoForm {
  prompt: string
  aspect?: (typeof ASPECTS)[number]
  duration_sec?: number
  title?: string
  look?: string | null
  sound?: (typeof SOUNDS)[number]
  voiceover?: boolean
  voice?: string
  script?: string[]
}

const FORM: Record<keyof VideoForm, PropertySchema> = {
  prompt: {
    type: 'string',
    minLength: 10,
    maxLength: 4000,
    description: 'What the video should show. Quote exact on-screen text.',
  },
  aspect: { type: 'string', enum: ASPECTS, description: '16:9 (default), 9:16, 1:1 or 4:5.' },
  duration_sec: {
    type: 'integer',
    minimum: 3,
    maximum: 600,
    description: 'Target length; leave out to let the agent choose.',
  },
  title: { type: 'string', maxLength: 120 },
  look: {
    type: ['string', 'null'],
    maxLength: 64,
    description: 'A look id (see the Look picker), or null for none.',
  },
  sound: {
    type: 'string',
    enum: SOUNDS,
    description: 'silent (default), music, or music_sfx (music and effects).',
  },
  voiceover: { type: 'boolean', description: 'A spoken narration with captions from its words.' },
  voice: {
    type: 'string',
    maxLength: 40,
    description: 'A voice id for the voice-over; leave out for the default.',
  },
  script: {
    type: 'array',
    items: { type: 'string', maxLength: 400 },
    maxItems: 30,
    description: 'Optional voice-over lines, one per scene.',
  },
}

const formSchema = (required: (keyof VideoForm)[]): InputSchema => ({
  type: 'object',
  properties: FORM,
  required,
  additionalProperties: false,
})

/** What the page needs to set its form and send the create, exactly as its own Create button does. */
export interface NewVideoPage {
  /** False for people who can't create videos: no tools then. */
  canCreate: boolean
  /** Look ids this deployment offers now (empty: no looks). */
  looks: string[]
  /** Sets every field the person would, so they see what the agent chose. */
  fill: (f: VideoForm) => void
  /** Sends the create the page's Create button sends (no plan); resolves to the new video's id. */
  create: (f: VideoForm) => Promise<string>
}

function lookProblem(f: VideoForm, looks: string[]) {
  if (f.look === undefined || f.look === null) return null
  if (looks.includes(f.look)) return null
  return fail(
    'invalid_input',
    `There's no look "${f.look}" here.`,
    looks.length
      ? `Use one of ${looks.join(', ')}, or null for none.`
      : 'This deployment has no looks; leave look out.',
  )
}

export function useNewVideoTools(page: NewVideoPage) {
  useWebMcpTool<VideoForm>(
    page.canCreate
      ? {
          name: 'fill_video_form',
          title: 'Fill the New video form',
          kind: 'act',
          description:
            'Fill the New video form the person sees (prompt, shape, length, title, look, sound, voice-over) without creating anything, so they can check it or press Create video themselves. Use create_video to create it.',
          input: formSchema(['prompt']),
          check: (f) => lookProblem(f, page.looks),
          run: (f) => {
            page.fill(f)
            return ok({ filled: Object.keys(f) })
          },
        }
      : null,
  )

  useWebMcpTool<VideoForm>(
    page.canCreate
      ? {
          name: 'create_video',
          title: 'Create a video',
          kind: 'consequential',
          description:
            'Create a new video from a prompt (and optionally shape, length, title, look, sound and voice-over). It spends credits, so the person confirms in the app first. Returns the new video id at once; it is ready in 3 to 8 minutes, and the page opens it.',
          input: formSchema(['prompt']),
          confirm: (f) => ({
            title: 'Create a video',
            body: `Make a new ${f.aspect ?? '16:9'} video${f.duration_sec ? ` of about ${String(f.duration_sec)} seconds` : ''}: "${f.prompt.slice(0, 300)}${f.prompt.length > 300 ? '…' : ''}". This starts an agent run that spends AI credits.`,
            action: 'Create video',
          }),
          check: (f) => lookProblem(f, page.looks),
          run: async (f) => {
            page.fill(f)
            const id = await page.create(f)
            return ok({
              video_id: id,
              status: 'queued',
              next: 'The page opens the video; use get_video there to follow it.',
            })
          },
        }
      : null,
  )
}
