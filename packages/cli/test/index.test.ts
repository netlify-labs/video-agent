import { expect, it } from 'vitest'
import { main } from '../src/index.js'

const run = async (argv: string[]) => {
  const out = { stdout: '', stderr: '' }
  const code = await main(argv, { stdout: (t) => (out.stdout += t), stderr: (t) => (out.stderr += t) })
  return { code, ...out }
}

it('prints its version and refuses unknown commands', async () => {
  expect(await run(['--version'])).toEqual({ code: 0, stdout: '0.0.0\n', stderr: '' })
  expect((await run(['create'])).code).toBe(2)
})
