// The Voice-over choice (SPIKES.md S9) for create, revise and plans: on or off, a voice, a pace and an optional script
// with one line per beat. Without a script, the plan's narration or the agent's own words are spoken.
import { Button, Group, SegmentedControl, Select, Stack, Switch, Text, Textarea } from '@mantine/core'
import type { components } from '../api/schema'

export type VoiceoverInput = components['schemas']['VoiceoverInput']
export type Voiceover = components['schemas']['Version']['voiceover']

export interface VoiceState {
  enabled: boolean
  voice: string
  speed: number
  script: string[]
}

export const VOICE_OFF: VoiceState = { enabled: false, voice: '', speed: 1, script: [] }

// Kokoro voices on the runner (npx hyperframes tts --list). An empty value is the default voice.
const VOICES = [
  { value: '', label: 'Default (Heart)' },
  { value: 'af_heart', label: 'Heart · US, warm' },
  { value: 'af_nova', label: 'Nova · US, bright' },
  { value: 'af_sky', label: 'Sky · US, upbeat' },
  { value: 'am_adam', label: 'Adam · US, calm' },
  { value: 'am_michael', label: 'Michael · US, confident' },
  { value: 'bf_emma', label: 'Emma · UK, clear' },
  { value: 'bf_isabella', label: 'Isabella · UK, soft' },
  { value: 'bm_george', label: 'George · UK, steady' },
]
const PACES = [
  { value: '0.9', label: 'Slower' },
  { value: '1', label: 'Normal' },
  { value: '1.1', label: 'Faster' },
]
const MAX_LINES = 12

export function voiceStateFrom(v: Voiceover | null | undefined): VoiceState {
  if (!v) return VOICE_OFF
  return { enabled: true, voice: v.voice ?? '', speed: v.speed ?? 1, script: v.script ?? [] }
}

/** The request body field: off, or on with only what was chosen. */
export function voiceInput(s: VoiceState): VoiceoverInput {
  if (!s.enabled) return { enabled: false }
  const script = s.script.map((l) => l.trim()).filter(Boolean)
  return {
    enabled: true,
    ...(s.voice ? { voice: s.voice } : {}),
    ...(s.speed !== 1 ? { speed: s.speed } : {}),
    ...(script.length ? { script } : {}),
  }
}

export const sameVoice = (a: VoiceState, b: VoiceState) =>
  JSON.stringify(voiceInput(a)) === JSON.stringify(voiceInput(b))

export function VoiceoverControl(props: {
  value: VoiceState
  onChange: (v: VoiceState) => void
  disabled?: boolean
  /** Shown under the script while planning: the brief will write narration for empty scripts. */
  planning?: boolean
}) {
  const v = props.value
  const set = (patch: Partial<VoiceState>) => {
    props.onChange({ ...v, ...patch })
  }
  const lines = v.script.length ? v.script : ['']
  return (
    <div>
      <Switch
        label="Voice-over"
        description="A narrator reads a line per beat; captions follow the words."
        checked={v.enabled}
        disabled={props.disabled === true}
        onChange={(e) => {
          set({ enabled: e.currentTarget.checked })
        }}
        data-testid="voiceover-switch"
      />
      {v.enabled ? (
        <Stack gap="sm" mt="sm" data-testid="voiceover-options">
          <Group gap="sm" align="end">
            <Select
              label="Voice"
              data={VOICES}
              value={v.voice}
              allowDeselect={false}
              disabled={props.disabled === true}
              onChange={(x) => {
                set({ voice: x ?? '' })
              }}
              w={220}
            />
            <div>
              <Text size="sm" fw={500} mb={4} id="pace-label">
                Pace
              </Text>
              <SegmentedControl
                aria-labelledby="pace-label"
                value={String(v.speed)}
                disabled={props.disabled === true}
                data={PACES}
                onChange={(x) => {
                  set({ speed: Number(x) })
                }}
              />
            </div>
          </Group>
          <div data-testid="voiceover-script">
            <Text size="sm" fw={500}>
              Script
            </Text>
            <Text size="xs" c="var(--va-faint)" mb={6}>
              {props.planning
                ? 'Optional. One line per beat, read word for word. Leave it empty and the plan writes the narration.'
                : 'Optional. One line per beat, read word for word. Leave it empty and the agent writes the narration.'}
            </Text>
            <Stack gap={6}>
              {lines.map((line, i) => (
                <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
                  <Textarea
                    aria-label={`Line ${i + 1}`}
                    placeholder={i === 0 ? 'Meet org webhooks: one subscription for every project.' : ''}
                    autosize
                    minRows={1}
                    maxLength={600}
                    style={{ flex: 1 }}
                    value={line}
                    disabled={props.disabled === true}
                    onChange={(e) => {
                      const next = [...lines]
                      next[i] = e.currentTarget.value
                      set({ script: next })
                    }}
                  />
                  {lines.length > 1 ? (
                    <Button
                      variant="subtle"
                      color="gray"
                      size="compact-sm"
                      aria-label={`Remove line ${i + 1}`}
                      disabled={props.disabled === true}
                      onClick={() => {
                        set({ script: lines.filter((_, j) => j !== i) })
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                </Group>
              ))}
            </Stack>
            {lines.length < MAX_LINES ? (
              <Button
                variant="subtle"
                size="compact-sm"
                mt={6}
                disabled={props.disabled === true}
                onClick={() => {
                  set({ script: [...lines, ''] })
                }}
              >
                Add a line
              </Button>
            ) : null}
          </div>
        </Stack>
      ) : null}
    </div>
  )
}
