// --upload local in the run prompts (cli-and-sdk plan §7; bead va-p1th.5.1): for the same input, a local prompt differs
// from a blobs one only in the --upload argument, in every builder; blobs prompts are unchanged.
import { describe, expect, it } from 'vitest'
import {
  buildFitPrompt,
  buildPrompt,
  buildQuickDemoPrompt,
  buildRenderUnchangedPrompt,
  uploadArg,
  type PromptUpload,
} from '../src/domain/prompt.js'

const run = {
  jobId: 'vid_1',
  attemptId: 'att_1',
  versionN: 2,
  runManifestSha256: 'b'.repeat(64),
  callbackUrl: 'https://x/cb/done',
  checkpointUrl: 'https://x/cb/checkpoint',
  callbackToken: 'tok',
}
const BUILDERS: [string, (upload: PromptUpload) => string][] = [
  [
    'buildPrompt',
    (upload) =>
      buildPrompt({
        ...run,
        requesterName: 'Rae',
        userPrompt: 'A 20 second launch video.',
        aspect: '16:9',
        targetDurationSec: 20,
        upload,
        revision: null,
        media: [],
      }),
  ],
  ['buildRenderUnchangedPrompt', (upload) => buildRenderUnchangedPrompt({ ...run, editedFromN: 1, upload })],
  [
    'buildFitPrompt',
    (upload) =>
      buildFitPrompt({
        ...run,
        editedFromN: 1,
        requesterName: 'Rae',
        aspect: '16:9',
        targetSamples: 480_000,
        upload,
      }),
  ],
  [
    'buildQuickDemoPrompt',
    (upload) =>
      buildQuickDemoPrompt({
        ...run,
        mediaId: 'med_1',
        aspect: '16:9',
        targetDurationSec: null,
        title: 'Demo',
        upload,
      }),
  ],
]

describe('--upload in the run prompts', () => {
  it('uploadArg writes blobs, local and a signed URL', () => {
    expect(uploadArg({ mode: 'blobs' })).toBe('--upload blobs')
    expect(uploadArg({ mode: 'local' })).toBe('--upload local')
    expect(uploadArg({ mode: 'signed', url: 'https://u/x' })).toBe('--upload https://u/x')
  })

  it.each(BUILDERS)('%s: local differs from blobs only in --upload', (_name, build) => {
    const blobs = build({ mode: 'blobs' })
    const local = build({ mode: 'local' })
    expect(blobs).toContain('--upload blobs')
    expect(local).not.toContain('--upload blobs')
    expect(local).toBe(blobs.replaceAll('--upload blobs', '--upload local'))
  })
})
