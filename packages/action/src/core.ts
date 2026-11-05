// The small part of @actions/core the action needs, written against GitHub's documented workflow commands and
// environment files, so the bundle has no dependencies to fetch or audit
// (https://docs.github.com/actions/reference/workflow-commands-for-github-actions).
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

export interface Core {
  /** An input's value, trimmed; "" when unset. */
  getInput(name: string): string
  setOutput(name: string, value: string): void
  /** Masks the value in every later log line. */
  setSecret(value: string): void
  info(message: string): void
  warning(message: string): void
  /** Fails the step: an error annotation and exit code 1. */
  setFailed(message: string): void
  startGroup(name: string): void
  endGroup(): void
  /** Appends Markdown to the job summary. */
  summary(markdown: string): void
}

/** Workflow-command data can't contain raw newlines or a bare %. */
const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

export function envCore(
  env: Record<string, string | undefined> = process.env,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  append: (file: string, text: string) => void = (file, text) => appendFileSync(file, text),
): Core {
  return {
    getInput: (name) => (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim(),
    setOutput: (name, value) => {
      const file = env.GITHUB_OUTPUT
      if (!file) {
        write(`::set-output name=${name}::${escapeData(value)}`)
        return
      }
      const delimiter = `ghadelimiter_${randomUUID()}`
      append(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
    },
    setSecret: (value) => {
      if (value) write(`::add-mask::${escapeData(value)}`)
    },
    info: (message) => write(message),
    warning: (message) => write(`::warning::${escapeData(message)}`),
    setFailed: (message) => {
      write(`::error::${escapeData(message)}`)
      process.exitCode = 1
    },
    startGroup: (name) => write(`::group::${escapeData(name)}`),
    endGroup: () => write('::endgroup::'),
    summary: (markdown) => {
      const file = env.GITHUB_STEP_SUMMARY
      if (file) append(file, `${markdown}\n`)
    },
  }
}
