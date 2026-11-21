// The agents, models and efforts a video's run can be given. Copied from netlify-agent-executor
// (src/core/agents/configuration.js), which syncs it from netlify-react-ui AgentConfigModal/models.ts
// (commit 0a61ba66, 2026-08-06). Pure data: the server validates a choice against it and the web app lists it.

export const AGENT_IDS = ['claude', 'gemini', 'codex', 'opencode'] as const
export type AgentId = (typeof AGENT_IDS)[number]

/** `wire`: what Agent Runner is sent when it differs from the id. */
export interface AgentEffort {
  id: string
  label: string
  wire?: string
}
export interface AgentModel {
  id: string
  label: string
  efforts: readonly AgentEffort[]
}
export interface AgentProvider {
  id: AgentId
  label: string
  models: readonly AgentModel[]
}

/** A video's chosen agent. model or effort null: Agent Runner's own choice for that agent. */
export interface RunnerChoice {
  agent: AgentId
  model: string | null
  effort: string | null
}

const LMH: readonly AgentEffort[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
]
const HIGH_MAX: readonly AgentEffort[] = [
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max', wire: 'xhigh' },
]
const LOW_HIGH_MAX: readonly AgentEffort[] = [
  { id: 'low', label: 'Low' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
]
const lmh = (id: string, label: string): AgentModel => ({ id, label, efforts: LMH })

export const AGENT_CATALOG: readonly AgentProvider[] = [
  {
    id: 'claude',
    label: 'Claude',
    models: [
      lmh('claude-opus-5-5', 'Opus 5.5'),
      lmh('claude-opus-5', 'Opus 5'),
      lmh('claude-opus-4-8', 'Opus 4.8'),
      lmh('claude-fable-5-2', 'Fable 5.2'),
      lmh('claude-fable-5-1', 'Fable 5.1'),
      lmh('claude-fable-5', 'Fable 5'),
      lmh('claude-sonnet-5-5', 'Sonnet 5.5'),
      lmh('claude-sonnet-5', 'Sonnet 5'),
      lmh('claude-haiku-5-5', 'Haiku 5.5'),
      lmh('claude-haiku-4-5', 'Haiku 4.5'),
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    models: [
      lmh('gemini-3.1-pro-preview', 'Gemini 3.1 Pro'),
      lmh('gemini-3.6-flash', 'Gemini 3.6 Flash'),
      lmh('gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'),
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    models: [
      lmh('gpt-6.1-sol', 'GPT 6.1 Sol'),
      lmh('gpt-5.6-sol', 'GPT 5.6 Sol'),
      lmh('gpt-5.6-terra', 'GPT 5.6 Terra'),
      lmh('gpt-5.6-luna', 'GPT 5.6 Luna'),
      lmh('gpt-5.4-mini', 'GPT 5.4 Mini'),
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    models: [
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3', efforts: LOW_HIGH_MAX },
      { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code', efforts: [] },
      { id: 'z-ai/glm-5.2', label: 'GLM 5.2', efforts: HIGH_MAX },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', efforts: HIGH_MAX },
      { id: '~deepseek/deepseek-v4-flash-latest', label: 'DeepSeek V4 Flash Latest', efforts: LOW_HIGH_MAX },
      lmh('x-ai/grok-4.5', 'Grok 4.5'),
      { id: 'minimax/minimax-m3', label: 'MiniMax M3', efforts: [] },
    ],
  },
]

export const agentProvider = (id: string): AgentProvider | undefined => AGENT_CATALOG.find((p) => p.id === id)

/**
 * Checks a choice against the catalog. Returns the choice, or a sentence saying what's wrong with it.
 * An effort needs a model, since each model has its own efforts.
 */
export function checkRunnerChoice(input: {
  agent: string
  model?: string | null | undefined
  effort?: string | null | undefined
}): { ok: true; choice: RunnerChoice } | { ok: false; message: string } {
  const provider = agentProvider(input.agent)
  if (!provider) return { ok: false, message: `There's no agent called "${input.agent}".` }
  const model = input.model ?? null
  const effort = input.effort ?? null
  if (model === null) {
    if (effort !== null) return { ok: false, message: 'Choose a model to set an effort.' }
    return { ok: true, choice: { agent: provider.id, model: null, effort: null } }
  }
  const m = provider.models.find((x) => x.id === model)
  if (!m) return { ok: false, message: `${provider.label} has no model called "${model}".` }
  if (effort !== null && !m.efforts.some((e) => e.id === effort)) {
    return {
      ok: false,
      message:
        m.efforts.length > 0
          ? `${m.label} takes the efforts ${m.efforts.map((e) => e.id).join(', ')}, not "${effort}".`
          : `${m.label} takes no effort.`,
    }
  }
  return { ok: true, choice: { agent: provider.id, model, effort } }
}

/** The effort as Agent Runner takes it. */
export function wireEffort(choice: RunnerChoice): string | null {
  if (choice.effort === null || choice.model === null) return null
  const e = agentProvider(choice.agent)
    ?.models.find((m) => m.id === choice.model)
    ?.efforts.find((x) => x.id === choice.effort)
  return e?.wire ?? choice.effort
}
