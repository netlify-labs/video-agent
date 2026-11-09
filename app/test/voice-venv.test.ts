// Local mode's voice and Netlify CLI rules (cli-and-sdk plan §7; bead va-p1th.5.3): with VA_PYTHON, Kokoro installs
// into that venv (never --user, never the person's pip config); without it, the runner path is unchanged; and
// VA_NETLIFY_CLI=off makes any Netlify CLI call fail fast.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { netlifyCli } from '../../scripts/lib/run-tools.js'
import { ensureKokoro } from '../../scripts/lib/voice-providers.js'

/** A fake interpreter: `-c import …` fails until `-m pip install` ran; every call is logged with PIP_CONFIG_FILE. */
function stubPython(installed = false) {
  const dir = mkdtempSync(join(tmpdir(), 'va-py-'))
  const calls = join(dir, 'calls.log')
  const flag = join(dir, 'installed')
  if (installed) writeFileSync(flag, '')
  const python = join(dir, 'python')
  writeFileSync(
    python,
    `#!/bin/sh
echo "$* | PIP_CONFIG_FILE=$PIP_CONFIG_FILE" >> "${calls}"
if [ "$1" = "-c" ]; then [ -f "${flag}" ]; exit $?; fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then touch "${flag}"; exit 0; fi
exit 1
`,
  )
  chmodSync(python, 0o755)
  return { python, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []) }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Kokoro in a venv (VA_PYTHON)', () => {
  it('installs kokoro-onnx>=0.6 into the venv, without --user and without the pip config', () => {
    const py = stubPython()
    ensureKokoro({ ...process.env, VA_PYTHON: py.python, PIP_CONFIG_FILE: '/home/me/pip.conf' })
    const calls = py.calls()
    expect(calls[0]).toMatch(/^-c import kokoro_onnx, soundfile/)
    expect(calls[1]).toBe('-m pip install --quiet kokoro-onnx>=0.6 soundfile | PIP_CONFIG_FILE=/dev/null')
    expect(calls.join('\n')).not.toMatch(/--user|--break-system-packages/)
  })

  it('does nothing when it is already installed', () => {
    const py = stubPython(true)
    ensureKokoro({ ...process.env, VA_PYTHON: py.python })
    expect(py.calls()).toHaveLength(1)
  })

  it('a failed install says which interpreter, so doctor and the person can see it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-py-'))
    const python = join(dir, 'python')
    writeFileSync(
      python,
      '#!/bin/sh\necho "No matching distribution found for kokoro-onnx>=0.6" >&2\nexit 1\n',
    )
    chmodSync(python, 0o755)
    expect(() => {
      ensureKokoro({ ...process.env, VA_PYTHON: python })
    }).toThrow(new RegExp(`${python} -m pip install failed: No matching distribution`))
  })
})

describe('VA_NETLIFY_CLI=off', () => {
  it('any Netlify CLI call fails fast with a clear message', () => {
    vi.stubEnv('VA_NETLIFY_CLI', 'off')
    expect(() => netlifyCli()).toThrow(
      'This is a local run (VA_NETLIFY_CLI=off), which never calls the Netlify CLI, but a step tried to. Use --upload local, a file: callback and --inputs. Stop and report this.',
    )
  })

  it('unset, the runner path is unchanged', () => {
    vi.stubEnv('VA_NETLIFY_CLI', '')
    expect(netlifyCli().length).toBeGreaterThan(0)
  })
})
