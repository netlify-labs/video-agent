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
// Short samples of each voice, made once with the same Kokoro voices the runs use, so previews cost nothing.
const SAMPLES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../assets/voices/*.mp3', { eager: true, query: '?url', import: 'default' }),
  ).map(([path, url]) => [path.replace(/^.*\/|\.mp3$/g, ''), url]),
)
const DEFAULT_VOICE = 'af_heart'

/** A built-in voice's name for people (Heart · US, warm); any other id stays as it is. */
export const voiceLabel = (voice: string | null | undefined) =>
  VOICES.find((x) => x.value === (voice ?? ''))?.label ?? voice ?? 'Default (Heart)'

interface ElevenLabsChoices {
  /** This deployment has ElevenLabs: the picker offers its voices and the default is one of them. */
  on: boolean
  voices: { value: string; label: string; name: string; previewUrl: string | null }[]
  defaultLabel: string
}

/** The deployment's ElevenLabs voices (GET /api/v1/voices), when it has ElevenLabs. */
function useElevenLabs(): ElevenLabsChoices {
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  const on = config.data?.features.includes('elevenlabs_voices') === true
  const list = $api.useQuery('get', '/api/v1/voices', {}, { enabled: on, staleTime: 5 * 60_000 })
  const items = on ? (list.data?.items ?? []) : []
  const voices = items.map((x) => ({
    value: x.id,
    // Prefixed, so the closed picker shows whose voice is chosen.
    label: `ElevenLabs - ${x.description ? `${x.name}, ${x.description}` : x.name}`,
    name: x.name,
    previewUrl: x.previewUrl,
  }))
  const def = items.find((x) => x.id === list.data?.default)
  return { on, voices, defaultLabel: def ? `Default (ElevenLabs - ${def.name})` : 'Default (ElevenLabs)' }
}

/** A voice's name for people, ElevenLabs voices included (Version details). */
export function useVoiceLabel(): (voice: string | null | undefined) => string {
  const el = useElevenLabs()
  return (voice) => {
    if (!voice && el.on) return el.defaultLabel
    return el.voices.find((x) => x.value === voice)?.label ?? voiceLabel(voice)
  }
}

/** The picker's choices: with ElevenLabs, its voices first (the default is one of them), then the built-in ones. */
function voiceChoices(el: ElevenLabsChoices, chosen: string) {
  if (!el.on) return VOICES
  const known = !chosen || [...VOICES, ...el.voices].some((x) => x.value === chosen)
  return [
    {
      group: 'ElevenLabs',
      items: [
        { value: '', label: el.defaultLabel },
        ...el.voices.map(({ value, label }) => ({ value, label })),
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
  const toggle = (voice: string, url: string | undefined) => {
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
  const el = useElevenLabs()
  // With ElevenLabs, the default voice is whichever one the deployment set.
  const chosen = v.voice || (el.on ? '' : DEFAULT_VOICE)
  const nameOf = (voice: string) =>
    el.voices.find((x) => x.value === voice)?.name ??
    (VOICES.find((x) => x.value === voice)?.label ?? voice).split(' · ')[0] ??
    voice
  // Built-in voices have a sample in the bundle; ElevenLabs voices bring a link to theirs.
  const sampleOf = (voice: string): string | undefined =>
    SAMPLES[voice] ?? el.voices.find((x) => x.value === voice)?.previewUrl ?? undefined
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
                data={voiceChoices(el, v.voice)}
                value={v.voice}
                allowDeselect={false}
                disabled={props.disabled === true}
                onChange={(x) => {
                  set({ voice: x ?? '' })
                }}
                w={el.on ? 340 : 220}
                renderOption={({ option }) => {
                  const voice = option.value
                  return (
                    <Group justify="space-between" wrap="nowrap" w="100%" gap="xs">
                      <span>{option.label}</span>
                      {option.value && sampleOf(voice) ? (
                        <PreviewButton
                          voice={voice}
                          label={nameOf(voice)}
                          playing={preview.playing === voice}
                          onToggle={() => {
                            preview.toggle(voice, sampleOf(voice))
                          }}
                        />
                      ) : null}
                    </Group>
                  )
                }}
              />
              {sampleOf(chosen) ? (
                <div style={{ paddingBottom: 6 }}>
                  <PreviewButton
                    voice={`chosen-${chosen}`}
                    label={nameOf(chosen)}
                    playing={preview.playing === chosen}
                    onToggle={() => {
                      preview.toggle(chosen, sampleOf(chosen))
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
