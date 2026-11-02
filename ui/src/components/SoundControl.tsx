// The Sound choice for a version (create, revise, plan): silent, a music bed, or music plus sound effects. The track
// itself is picked through the media chips; without one, the brand's music in context/ is used, else none.
import { SegmentedControl, Text } from '@mantine/core'
import type { components } from '../api/schema'
import { brand } from '../theme'
import type { Media } from './MediaPicker'

export type Sound = components['schemas']['Sound']

const OPTIONS: { value: Sound; label: string }[] = [
  { value: 'silent', label: 'Silent' },
  { value: 'music', label: 'Music' },
  { value: 'music_sfx', label: 'Music + effects' },
]

/** A new audio pick turns music on, unless the person already chose a sound themselves. */
export function soundAfterPick(sound: Sound, touched: boolean, before: Media[], after: Media[]): Sound {
  const added = after.some((m) => m.kind === 'audio' && !before.some((b) => b.id === m.id))
  return added && sound === 'silent' && !touched ? 'music' : sound
}

export function SoundControl(props: {
  value: Sound
  onChange: (s: Sound) => void
  media: Media[]
  disabled?: boolean
}) {
  const track = props.media.find((m) => m.kind === 'audio')
  const hint =
    props.value === 'silent'
      ? 'No audio. Captions carry the words.'
      : track
        ? `Music: ${track.filename}.`
        : brand.music
          ? "Music: the brand's track. Add an audio file to use another."
          : 'Add an audio file from the media library, or the agent finds a CC0 or CC BY track on Openverse.'
  return (
    <div>
      <Text size="sm" fw={500} mb={8} id="sound-label">
        Sound
      </Text>
      <SegmentedControl
        aria-labelledby="sound-label"
        value={props.value}
        disabled={props.disabled === true}
        onChange={(v) => {
          props.onChange(v)
        }}
        data={OPTIONS}
        data-testid="sound-control"
      />
      <Text size="xs" c="var(--va-faint)" mt={6}>
        {hint}
        {props.value === 'music_sfx' ? ' Effects only mark actions on screen.' : ''}
      </Text>
    </div>
  )
}
