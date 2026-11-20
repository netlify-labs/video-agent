// The Voice-over choice (docs/spikes.md S9) for create, revise and plans: on or off, a voice, a pace and an optional script
// with one line per beat. Without a script, the plan's narration or the agent's own words are spoken.
import {
  ActionIcon,
  Button,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core'
import { IconPlayerPlay, IconPlayerStop } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { $api } from '../api/client'
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
// ElevenLabs' default voices, which every plan (the free one too) may use through the API. Offered when the
// deployment has ELEVENLABS_API_KEY (the elevenlabs_voices feature); a run speaks any other voice id it is given.
const ELEVENLABS_VOICES = [
  { value: 'CwhRBWXzGAHq8TQ4Fs17', label: 'Roger · US, laid-back' },
  { value: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah · US, warm' },
  { value: 'pNInz6obpgDQGcFmaJgB', label: 'Adam · US, deep' },
  { value: 'JBFqnCBsd6RMkjVDRZzb', label: 'George · UK, storyteller' },
  { value: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel · UK, newsreader' },
]
const ALL_VOICES = [...VOICES, ...ELEVENLABS_VOICES]
// Short samples of each voice, made once with the same Kokoro voices the runs use, so previews cost nothing.
const SAMPLES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../assets/voices/*.mp3', { eager: true, query: '?url', import: 'default' }),
  ).map(([path, url]) => [path.replace(/^.*\/|\.mp3$/g, ''), url]),
)
const DEFAULT_VOICE = 'af_heart'

/** A voice's name for people (Heart · US, warm); an ElevenLabs id stays as it is. */
export const voiceLabel = (voice: string | null | undefined) =>
  ALL_VOICES.find((x) => x.value === (voice ?? ''))?.label ?? voice ?? 'Default (Heart)'

/** Whether this deployment has an ElevenLabs key, so the picker offers its voices and the default is one of them. */
function useElevenLabs(): boolean {
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  return config.data?.features.includes('elevenlabs_voices') === true
}

/** The picker's choices: with a key, ElevenLabs first (the default is its voice), then the built-in voices. */
function voiceChoices(elevenlabs: boolean, chosen: string) {
  if (!elevenlabs) return VOICES
  const known = ALL_VOICES.some((x) => x.value === chosen)
  return [
    {
      group: 'ElevenLabs',
      items: [
        { value: '', label: 'Default (ElevenLabs)' },
        ...ELEVENLABS_VOICES,
        // A voice id set through the API or CLI stays selectable.
        ...(known ? [] : [{ value: chosen, label: chosen }]),
      ],
    },
    { group: 'Built in (Kokoro)', items: VOICES.filter((x) => x.value) },
  ]
}

/** One sample plays at a time; returns the voice playing and a toggle. */
function usePreview() {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(
    () => () => {
      audio.current?.pause()
    },
    [],
  )
  const toggle = (voice: string) => {
    const url = SAMPLES[voice]
    audio.current?.pause()
    if (!url || playing === voice) {
      setPlaying(null)
      return
    }
    const a = new Audio(url)
    a.onended = () => {
      setPlaying((p) => (p === voice ? null : p))
    }
    audio.current = a
    setPlaying(voice)
    void a.play().catch(() => {
      setPlaying(null)
    })
  }
  return { playing, toggle }
}

function PreviewButton(props: { voice: string; label: string; playing: boolean; onToggle: () => void }) {
  return (
    <Tooltip label={props.playing ? 'Stop' : `Hear ${props.label}`} withinPortal>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={props.playing ? `Stop ${props.label}` : `Hear ${props.label}`}
        data-testid={`voice-preview-${props.voice}`}
        // Inside the dropdown, a press must play the sample, not pick the voice.
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onClick={(e) => {
          e.stopPropagation()
          props.onToggle()
        }}
      >
        {props.playing ? <IconPlayerStop size={14} /> : <IconPlayerPlay size={14} />}
      </ActionIcon>
    </Tooltip>
  )
}

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
  const preview = usePreview()
  const elevenlabs = useElevenLabs()
  // With a key, the default voice is ElevenLabs', which has no sample here.
  const chosen = v.voice || (elevenlabs ? '' : DEFAULT_VOICE)
  const nameOf = (voice: string) =>
    (ALL_VOICES.find((x) => x.value === voice)?.label ?? voice).split(' · ')[0] ?? voice
  return (
    <div>
      <Switch
        label="Voice-over"
        description="A narrator reads a line per scene; captions follow the words."
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
            <Group gap={4} align="end" wrap="nowrap">
              <Select
                label="Voice"
                data={voiceChoices(elevenlabs, v.voice)}
                value={v.voice}
                allowDeselect={false}
                disabled={props.disabled === true}
                onChange={(x) => {
                  set({ voice: x ?? '' })
                }}
                w={220}
                renderOption={({ option }) => {
                  const voice = option.value
                  return (
                    <Group justify="space-between" wrap="nowrap" w="100%" gap="xs">
                      <span>{option.label}</span>
                      {option.value && SAMPLES[voice] ? (
                        <PreviewButton
                          voice={voice}
                          label={nameOf(voice)}
                          playing={preview.playing === voice}
                          onToggle={() => {
                            preview.toggle(voice)
                          }}
                        />
                      ) : null}
                    </Group>
                  )
                }}
              />
              {SAMPLES[chosen] ? (
                <div style={{ paddingBottom: 6 }}>
                  <PreviewButton
                    voice={`chosen-${chosen}`}
                    label={nameOf(chosen)}
                    playing={preview.playing === chosen}
                    onToggle={() => {
                      preview.toggle(chosen)
                    }}
                  />
                </div>
              ) : null}
            </Group>
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
                ? 'Optional. One line per scene, read word for word. Leave it empty and the plan writes the narration.'
                : 'Optional. One line per scene, read word for word. Leave it empty and the agent writes the narration.'}
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
