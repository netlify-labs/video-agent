// Redo a scene (regenerate-beat plan §4.12): the shown version's scenes as chips to pick from. The version's beats
// come with it, or from GET …/beats for a version made before they were stored. The chips follow the server's rules
// (lib/scenes.ts pickable), each disabled one saying why.
import { Chip, Group, Loader, Text, Tooltip } from '@mantine/core'
import { $api, errorMessage, type Version } from '../api/client'
import { pickable, sceneChipLabel } from '../lib/scenes'

/** The version's scenes: from the DTO, else asked for once. Null while loading or when it has none. */
function useScenes(videoId: string, v: Version) {
  const fill = $api.useQuery(
    'get',
    '/api/v1/videos/{id}/versions/{n}/beats',
    { params: { path: { id: videoId, n: v.n } } },
    { enabled: v.beats === null && v.status === 'ready' && v.editable },
  )
  return {
    beats: v.beats ?? fill.data?.beats ?? null,
    loading: fill.isLoading,
    error: fill.error ? errorMessage(fill.error) : null,
  }
}

export function ScenePicker(props: {
  videoId: string
  v: Version
  value: string[]
  onChange: (beats: string[]) => void
  disabled?: boolean
}) {
  const { beats, loading, error } = useScenes(props.videoId, props.v)
  if (loading) return <Loader size="sm" />
  if (error)
    return (
      <Text size="sm" c="red">
        {error}
      </Text>
    )
  if (!beats?.length)
    return (
      <Text size="sm" c="var(--va-muted)">
        This version has no scenes to pick from. Revise the whole video instead.
      </Text>
    )
  const chips = pickable(beats, props.value)
  return (
    <Group gap={6} data-testid="scene-picker" role="group" aria-label="Scenes to redo">
      {chips.map(({ beat, picked, disabled }, i) => (
        <Tooltip key={beat.id} label={disabled} disabled={!disabled} multiline w={260}>
          <span>
            <Chip
              size="sm"
              checked={picked}
              disabled={props.disabled || disabled !== null}
              onChange={(on) => {
                props.onChange(
                  on
                    ? chips.filter((c) => c.picked || c.beat.id === beat.id).map((c) => c.beat.id)
                    : props.value.filter((x) => x !== beat.id),
                )
              }}
            >
              {sceneChipLabel(i, beat)}
            </Chip>
          </span>
        </Tooltip>
      ))}
    </Group>
  )
}
