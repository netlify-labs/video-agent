// The voice-over setup panel on the mock build's /dev/recorder page (plan 2026-11-02 §2.1 step 2, §5.1). The mic and
// its device list are stand-ins (window.__vaTestMic, __vaTestMicDevices; see recorder.spec.ts for why): an oscillator
// gated one second on, one off, at a level the test picks, so the analyser meter and the 3 s level check are real. With
// `manual`, the test switches the sound on and off itself (window.__micOn), so nothing waits on the audio clock.
import { expect, test, type Page } from '@playwright/test'

/** The stand-in mic, as page script. __micCfg: amplitude, manual, and deny (a NotAllowedError until it's cleared). */
const TEST_MIC = `
window.__micCalls = []
window.__vaTestMicDevices = () => [
  { deviceId: 'mic-usb', label: 'USB Studio Mic' },
  { deviceId: 'mic-built-in', label: 'Built-in Microphone' },
]
window.__vaTestMic = (ctx, audio) => {
  const cfg = window.__micCfg || {}
  window.__micCalls.push(audio)
  if (cfg.deny) throw new DOMException('Permission denied', 'NotAllowedError')
  const osc = ctx.createOscillator()
  osc.frequency.value = 440
  const gate = ctx.createGain()
  const t = ctx.currentTime
  const amp = cfg.amplitude ?? 0.5
  if (cfg.manual) {
    gate.gain.value = amp
    window.__micGates = (window.__micGates || []).concat(gate)
    window.__micOn = (on) => window.__micGates.forEach((g) => { g.gain.value = on ? amp : 0 })
  } else for (let i = 0; i < 240; i++) gate.gain.setValueAtTime(i % 2 === 0 ? amp : 0, t + i)
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  osc.connect(gate).connect(dest)
  osc.start()
  return dest.stream
}`

const setup = async (page: Page, cfg: { amplitude?: number; deny?: boolean; manual?: boolean } = {}) => {
  await page.addInitScript({ content: `window.__micCfg = ${JSON.stringify(cfg)}` })
  await page.addInitScript({ content: TEST_MIC })
  await page.goto('/dev/recorder')
  await expect(page.getByTestId('recording-setup')).toBeVisible()
}
const options = async (page: Page) =>
  JSON.parse((await page.getByTestId('setup-options').textContent()) ?? '{}') as {
    recorder: { deviceId?: string; echoCancellation: boolean }
    tracks: { aiVoice: { mode: string; volumeDb: number }; original: { muteAll: boolean } }
  }
const lastMic = (page: Page) =>
  page.evaluate(() => {
    const calls = (globalThis as unknown as { __micCalls: Record<string, unknown>[] }).__micCalls
    return calls[calls.length - 1] ?? null
  })
const rmsDb = async (page: Page) => Number(await page.getByTestId('mic-meter').getAttribute('data-rms-db'))

test('setup: lists the mics, remembers the choice and opens it with the take constraints', async ({
  page,
}) => {
  await setup(page)
  await page.getByRole('button', { name: 'Check mic' }).click()
  await expect(page.getByTestId('mic-meter')).toBeVisible()
  expect(await lastMic(page)).toMatchObject({
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  })
  await page.getByTestId('mic-select').click()
  await expect(page.getByRole('option', { name: 'USB Studio Mic' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Built-in Microphone' })).toBeVisible()
  await page.getByRole('option', { name: 'USB Studio Mic' }).click()
  // The preview reopens on the new mic.
  await expect.poll(() => lastMic(page)).toMatchObject({ deviceId: { exact: 'mic-usb' } })
  expect((await options(page)).recorder).toEqual({ deviceId: 'mic-usb', echoCancellation: false })
  expect(await page.evaluate(() => localStorage.getItem('va.recorder.mic'))).toBe('mic-usb')

  await page.reload()
  await expect(page.getByTestId('recording-setup')).toBeVisible()
  expect((await options(page)).recorder.deviceId).toBe('mic-usb')
  await expect(page.getByTestId('mic-select')).toHaveValue('USB Studio Mic')
})

test('setup: the meter moves and the level check says OK', async ({ page }) => {
  await setup(page, { manual: true })
  await page.getByRole('button', { name: 'Check mic' }).click()
  // The meter follows the sound on, then off, then on again (the test switches it, so CI load can't skip a phase).
  const micOn = (on: boolean) => page.evaluate(`window.__micOn(${on})`)
  await expect.poll(() => rmsDb(page), { timeout: 10_000 }).toBeGreaterThan(-20)
  await micOn(false)
  await expect.poll(() => rmsDb(page), { timeout: 10_000 }).toBeLessThan(-50)
  await micOn(true)
  await expect.poll(() => rmsDb(page), { timeout: 10_000 }).toBeGreaterThan(-20)
  await page.getByRole('button', { name: 'Check level' }).click()
  await expect(page.getByTestId('level-verdict')).toHaveAttribute('data-verdict', 'ok', { timeout: 6000 })
  await expect(page.getByTestId('level-verdict')).toContainText('Sounds good')
  await expect(page.getByTestId('mic-clip')).toHaveAttribute('data-on', 'false')
})

test('setup: a hot mic latches the clip light and the check says too loud', async ({ page }) => {
  await setup(page, { amplitude: 1 })
  await page.getByRole('button', { name: 'Check mic' }).click()
  await expect(page.getByTestId('mic-clip')).toHaveAttribute('data-on', 'true', { timeout: 5000 })
  await page.getByRole('button', { name: 'Check level' }).click()
  await expect(page.getByTestId('level-verdict')).toHaveAttribute('data-verdict', 'clipping', {
    timeout: 6000,
  })
  await expect(page.getByTestId('level-verdict')).toContainText('Too loud')
})

test('setup: a quiet mic is too quiet', async ({ page }) => {
  await setup(page, { amplitude: 0.002 })
  await page.getByRole('button', { name: 'Check mic' }).click()
  await page.getByRole('button', { name: 'Check level' }).click()
  await expect(page.getByTestId('level-verdict')).toHaveAttribute('data-verdict', 'quiet', { timeout: 6000 })
  await expect(page.getByTestId('level-verdict')).toContainText('Move closer')
})

test('setup: a denied mic shows help, Upload instead, and Retry recovers', async ({ page, browserName }) => {
  await setup(page, { deny: true })
  await page.getByRole('button', { name: 'Check mic' }).click()
  const problem = page.getByTestId('mic-problem')
  await expect(problem).toContainText('The microphone is blocked')
  // The help names this browser's own setting (setup/mic.ts).
  await expect(problem).toContainText(
    browserName === 'firefox' ? 'remove the block' : 'set Microphone to Allow',
  )
  await expect(page.getByTestId('mic-meter')).toHaveCount(0)
  await problem.getByRole('button', { name: 'Upload a file instead' }).click()
  await expect(page.getByTestId('upload-instead')).toBeVisible()

  await page.evaluate(() => {
    ;(globalThis as unknown as { __micCfg: { deny: boolean } }).__micCfg.deny = false
  })
  await problem.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('mic-problem')).toHaveCount(0)
  await expect(page.getByTestId('mic-meter')).toBeVisible()
})

test('setup: output mode sets echo cancellation; original audio sets the track patch', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: 'Check mic' }).click()
  await expect(page.getByTestId('mic-meter')).toBeVisible()
  expect((await options(page)).recorder.echoCancellation).toBe(false)
  await expect(page.getByText('Bluetooth adds delay and lowers mic quality; wired is best.')).toBeVisible()

  await page.getByTestId('output-mode').getByText('Speakers').click()
  expect((await options(page)).recorder.echoCancellation).toBe(true)
  // The preview reopens with echo cancellation, as the take will.
  await expect.poll(() => lastMic(page)).toMatchObject({ echoCancellation: true })
  await expect(page.getByRole('radio', { name: 'Mute the video' })).toBeChecked()
  await page.getByRole('radio', { name: /Play it quietly/ }).check()

  // A take records with the same constraints.
  await page.getByRole('button', { name: 'Record', exact: true }).click()
  await expect(page.getByTestId('recorder-phase')).toHaveText('recording')
  expect(await lastMic(page)).toMatchObject({ echoCancellation: true })
  // Fixed for the take.
  await expect(page.getByTestId('output-mode').locator('input').first()).toBeDisabled()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByTestId('recorder-phase')).toHaveText('idle')

  await page.getByTestId('output-mode').getByText('Headphones').click()
  expect((await options(page)).recorder.echoCancellation).toBe(false)

  expect((await options(page)).tracks).toEqual({
    aiVoice: { mode: 'replace', volumeDb: -12 },
    original: { muteAll: false },
  })
  await page.getByRole('radio', { name: 'Keep it under my voice' }).check()
  await expect(page.getByTestId('ai-voice-db')).toBeVisible()
  expect((await options(page)).tracks.aiVoice).toEqual({ mode: 'under', volumeDb: -12 })
  await page.getByRole('radio', { name: 'Mute all original audio' }).check()
  expect((await options(page)).tracks).toEqual({
    aiVoice: { mode: 'under', volumeDb: -12 },
    original: { muteAll: true },
  })
})
