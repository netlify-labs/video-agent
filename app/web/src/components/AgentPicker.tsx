// The agent that makes a video: Auto (the deployment's default), or an Agent Runner agent with, optionally, one of
// its models and one of that model's efforts. The lists are the server's catalog (app/server/lib/agent-catalog.ts).
import { Group, Select, Text } from '@mantine/core'
import { AGENT_CATALOG, agentProvider, type AgentId } from '../../../server/lib/agent-catalog'

/** null: Auto. model or effort null: the agent's own choice. */
export interface AgentChoice {
  agent: AgentId
  model: string | null
  effort: string | null
}

const AUTO = 'auto'
const auto = { value: AUTO, label: 'Auto' }

/** The create request's `runner`, or nothing for Auto. */
export const runnerInput = (c: AgentChoice | null) =>
  c
    ? {
        runner: {
          agent: c.agent,
          ...(c.model ? { model: c.model } : {}),
          ...(c.model && c.effort ? { effort: c.effort } : {}),
        },
      }
    : {}

export function AgentPicker(props: {
  value: AgentChoice | null
  onChange: (next: AgentChoice | null) => void
  disabled?: boolean
}) {
  const { value } = props
  const provider = value ? agentProvider(value.agent) : undefined
  const model = provider?.models.find((m) => m.id === value?.model)
  const efforts = model?.efforts ?? []
  return (
    <div data-testid="agent-picker">
      <Text size="sm" fw={500}>
        Agent
      </Text>
      <Text size="xs" c="var(--va-faint)" mb={8}>
        Optional. Auto uses the default agent and model.
      </Text>
      <Group gap="sm" align="flex-end" wrap="wrap">
        <Select
          aria-label="Agent"
          w={160}
          data={[auto, ...AGENT_CATALOG.map((p) => ({ value: p.id, label: p.label }))]}
          value={value?.agent ?? AUTO}
          allowDeselect={false}
          disabled={props.disabled === true}
          onChange={(v) => {
            const p = v ? agentProvider(v) : undefined
            props.onChange(p ? { agent: p.id, model: null, effort: null } : null)
          }}
          data-testid="agent-select"
        />
        <Select
          aria-label="Model"
          w={230}
          data={[auto, ...(provider?.models ?? []).map((m) => ({ value: m.id, label: m.label }))]}
          value={value?.model ?? AUTO}
          allowDeselect={false}
          disabled={props.disabled === true || !value}
          onChange={(v) => {
            if (value) props.onChange({ ...value, model: v && v !== AUTO ? v : null, effort: null })
          }}
          data-testid="agent-model-select"
        />
        <Select
          aria-label="Effort"
          w={130}
          data={[auto, ...efforts.map((e) => ({ value: e.id, label: e.label }))]}
          value={value?.effort ?? AUTO}
          allowDeselect={false}
          disabled={props.disabled === true || efforts.length === 0}
          onChange={(v) => {
            if (value) props.onChange({ ...value, effort: v && v !== AUTO ? v : null })
          }}
          data-testid="agent-effort-select"
        />
      </Group>
    </div>
  )
}
