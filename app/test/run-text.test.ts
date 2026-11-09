// Run text redaction (app/server/lib/run-text.ts): each kind of secret in a command is hidden, ordinary steps read as they
// were, and the repo's own scripts read as what they do. Secrets are made at runtime (no secret-shaped literals).
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { redactSecrets, stepText } from '../server/lib/run-text.js'

const T = randomBytes(24).toString('base64url')
const ghp = ['gh', 'p_', 'a'.repeat(36)].join('')

describe('redactSecrets', () => {
  it.each([
    ['a --token flag', `x --token ${T} --upload blobs`, 'x --token [hidden] --upload blobs'],
    ['a --api-key= flag', `x --api-key=${T}`, 'x --api-key [hidden]'],
    [
      'an Authorization header',
      `curl -H "Authorization: Bearer ${T}"`,
      'curl -H "Authorization: Bearer [hidden]"',
    ],
    ['a bare Bearer value', `Bearer ${T}`, 'Bearer [hidden]'],
    ['a KEY= assignment', `VIDEO_AGENT_KEY=${T} node x`, 'VIDEO_AGENT_KEY=[hidden] node x'],
    ['a SECRET= assignment', `export NETLIFY_AUTH_SECRET="${T}"`, 'export NETLIFY_AUTH_SECRET=[hidden]'],
    ['a signed URL', `https://b.example/f.mp4?exp=1&sig=${T}`, 'https://b.example/f.mp4?exp=1&sig=[hidden]'],
    [
      'an S3 signature',
      `https://s3/x?X-Amz-Signature=abc123&X-Amz-Credential=AK`,
      'https://s3/x?X-Amz-Signature=[hidden]&X-Amz-Credential=[hidden]',
    ],
    ['a provider key', `token is ${ghp}`, 'token is [hidden]'],
  ])('%s', (_name, text, want) => {
    expect(redactSecrets(text)).toBe(want)
    expect(redactSecrets(text)).not.toContain(T)
  })

  it('leaves ordinary text alone', () => {
    for (const s of [
      'Writing the end card',
      'Asked: which plans should the walkthrough cover?',
      'npm run build --silent',
    ])
      expect(redactSecrets(s)).toBe(s)
  })
})

describe('stepText', () => {
  it("names the repo's own scripts and redacts any other command", () => {
    expect(stepText(`Run command \`npx tsx scripts/render-job.ts --token ${T}\``)).toBe(
      'Rendering the video and uploading it',
    )
    expect(stepText('Run command `cd video && npx hyperframes check`')).toBe('Checking the composition')
    expect(stepText('Run command `npx tsx scripts/voice.ts sync`')).toBe('Recording the voice-over')
    expect(stepText(`Run command \`curl -H "Authorization: Bearer ${T}" x\``)).toBe(
      'Run command `curl -H "Authorization: Bearer [hidden]" x`',
    )
    expect(stepText('Writing the composition')).toBe('Writing the composition')
    expect(stepText(null)).toBeNull()
    expect(stepText('x'.repeat(400))).toHaveLength(300)
  })
})
