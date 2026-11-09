// Looks in admin settings (plan 2026-11-04-looks §6): turn a look off, and pick the look new videos get when the
// person doesn't choose one. Versions already made with a look keep it. The server's refusals (a default that's turned
// off) are shown in the card.
import { Alert, Card, Select, Stack, Switch, Text } from '@mantine/core'
import { useQueryClient } from '@tanstack/react-query'
import { $api, errorMessage } from '../api/client'
import { useLooks } from './LookPicker'

export function LooksSettingsCard() {
  const qc = useQueryClient()
  const looks = useLooks()
  const settings = $api.useQuery('get', '/api/v1/admin/settings')
  const save = $api.useMutation('patch', '/api/v1/admin/settings', {
    onSuccess: () => void qc.invalidateQueries(),
  })
  const s = settings.data
  if (!looks || !s) return null
  const disabled = s.disabledLooks
  return (
    <Card data-testid="looks-settings">
      <Text fw={600} mb="xs">
        Looks
      </Text>
      <Text size="sm" c="var(--va-muted)" mb="sm">
        A look is a style a person can pick for a video. Turning one off hides it from the pickers; videos
        already made with it keep it.
      </Text>
      <Stack gap="xs">
        {looks.looks.map((l) => (
          <Switch
            key={l.id}
            label={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {l.preview.poster ? <img className="va-look-thumb" src={l.preview.poster} alt="" /> : null}
                {l.name}
              </span>
            }
            aria-label={`${l.name} look`}
            checked={!disabled.includes(l.id)}
            disabled={save.isPending}
            onChange={(e) => {
              const on = e.currentTarget.checked
              save.mutate({
                body: { disabledLooks: on ? disabled.filter((x) => x !== l.id) : [...disabled, l.id] },
              })
            }}
          />
        ))}
        <Select
          label="Default for new videos"
          description="Used when the person doesn't pick a look."
          data={[
            { value: 'none', label: 'None (the agent decides)' },
            ...looks.looks.map((l) => ({ value: l.id, label: l.name })),
          ]}
          value={s.defaultLook ?? 'none'}
          allowDeselect={false}
          disabled={save.isPending}
          onChange={(v) => {
            save.mutate({ body: { defaultLook: !v || v === 'none' ? null : v } })
          }}
          maw={320}
        />
        {save.error ? (
          <Alert color="red" data-testid="looks-settings-error">
            {errorMessage(save.error)}
          </Alert>
        ) : null}
      </Stack>
    </Card>
  )
}
