// Plan with questions (plan v2 §4): a side panel next to the prompt. A fast router decides whether questions would
// help; the person answers (or skips), gets an editable brief, and creates the video with it. Create now is always
// there, and leaving keeps the prompt.
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  NumberInput,
  Radio,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import { useEffect, useState } from 'react'
import { $api, errorMessage } from '../api/client'
import type { paths } from '../api/schema'

type Plan = paths['/api/v1/plans/{id}']['get']['responses'][200]['content']['application/json']
type Brief = NonNullable<Plan['brief']>
type Answer = { questionId: string; optionIds?: string[]; other?: string; skipped?: boolean }
type Aspect = '16:9' | '9:16' | '1:1' | '4:5'

export interface PlanPanelProps {
  prompt: string
  aspect?: Aspect | undefined
  durationSec?: number | undefined
  revisionOf?: { videoId: string; version?: number } | undefined
  /** Called with the plan id to create with it, or null to create without a plan. */
  onCreate: (planId: string | null) => void
  onSuggestAspect?: (aspect: Aspect) => void
  onClose: () => void
  creating: boolean
}

const isUnavailable = (e: unknown) =>
  Boolean(
    e &&
    typeof e === 'object' &&
    'error' in e &&
    (e as { error: { code?: string } }).error.code === 'planning_unavailable',
  )

export function PlanPanel(props: PlanPanelProps) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [brief, setBrief] = useState<Brief | null>(null)
  const [edited, setEdited] = useState(false)
  const [error, setError] = useState<{ unavailable: boolean; message: string } | null>(null)
  const onError = (e: unknown) => {
    setError({ unavailable: isUnavailable(e), message: errorMessage(e) })
  }

  const getBrief = $api.useMutation('post', '/api/v1/plans/{id}/brief', {
    onSuccess: (p) => {
      setPlan(p)
      setBrief(p.brief)
      setEdited(false)
    },
    onError,
  })
  const getQuestions = $api.useMutation('post', '/api/v1/plans/{id}/questions', {
    onSuccess: (p) => {
      setPlan(p)
      // The prompt covers it: go straight to the brief.
      if ((p.questions ?? []).length === 0)
        getBrief.mutate({ params: { path: { id: p.id } }, body: { answers: [] } })
    },
    onError,
  })
  const start = $api.useMutation('post', '/api/v1/plans', {
    onSuccess: (p) => {
      setPlan(p)
      if (p.route?.suggestedAspect && !props.aspect) props.onSuggestAspect?.(p.route.suggestedAspect)
      getQuestions.mutate({ params: { path: { id: p.id } } })
    },
    onError,
  })
  const save = $api.useMutation('patch', '/api/v1/plans/{id}', { onError })

  useEffect(() => {
    start.mutate({
      body: {
        prompt: props.prompt,
        ...(props.aspect ? { aspect: props.aspect } : {}),
        ...(props.durationSec ? { durationSec: props.durationSec } : {}),
        ...(props.revisionOf ? { revisionOf: props.revisionOf } : {}),
      },
    })
    // Start once per panel; the prompt is fixed while planning.
  }, [])

  const create = async () => {
    if (!plan) return props.onCreate(null)
    if (edited && brief) {
      await save.mutateAsync({
        params: { path: { id: plan.id }, header: { 'if-match': String(plan.briefRev) } },
        body: { brief },
      })
    }
    props.onCreate(plan.id)
  }

  const busy = start.isPending || getQuestions.isPending || getBrief.isPending
  const questions = plan?.questions ?? []
  const setAnswer = (id: string, patch: Partial<Answer>) => {
    setAnswers((a) => ({ ...a, [id]: { ...(a[id] ?? { questionId: id }), ...patch } }))
  }
  const editBrief = (patch: Partial<Brief>) => {
    setBrief((b) => (b ? { ...b, ...patch } : b))
    setEdited(true)
  }

  return (
    <Card className="va-plan">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Text fw={600}>Plan it first</Text>
          <Button variant="subtle" color="gray" size="compact-sm" onClick={props.onClose}>
            Close
          </Button>
        </Group>

        {error ? (
          <Alert color={error.unavailable ? 'gray' : 'red'} variant="light">
            {error.message}
          </Alert>
        ) : null}

        {busy ? (
          <Group gap="sm">
            <Loader size="sm" />
            <Text size="sm" c="var(--va-muted)">
              {start.isPending
                ? 'Reading your prompt…'
                : getQuestions.isPending
                  ? 'Thinking of a few questions…'
                  : 'Writing the brief…'}
            </Text>
          </Group>
        ) : null}

        {!busy && !brief && questions.length > 0 ? (
          <Stack gap="md">
            {questions.map((q) => {
              const a = answers[q.id]
              return (
                <Card key={q.id} className="va-plan-q" padding="md">
                  <Stack gap="xs">
                    <Group justify="space-between" align="flex-start" wrap="nowrap">
                      <Text fw={600} size="sm">
                        {q.question}
                      </Text>
                      <Checkbox
                        size="xs"
                        label="Skip"
                        checked={a?.skipped ?? false}
                        onChange={(e) => {
                          setAnswer(q.id, { skipped: e.currentTarget.checked })
                        }}
                      />
                    </Group>
                    {q.why ? (
                      <Text size="xs" c="var(--va-faint)">
                        {q.why}
                      </Text>
                    ) : null}
                    {q.multiSelect ? (
                      <Checkbox.Group
                        value={a?.optionIds ?? []}
                        onChange={(v) => {
                          setAnswer(q.id, { optionIds: v, skipped: false })
                        }}
                      >
                        <Stack gap={6}>
                          {q.options.map((o) => (
                            <Checkbox
                              key={o.id}
                              value={o.id}
                              label={o.label}
                              description={o.description || undefined}
                            />
                          ))}
                        </Stack>
                      </Checkbox.Group>
                    ) : (
                      <Radio.Group
                        value={a?.optionIds?.[0] ?? null}
                        onChange={(v) => {
                          setAnswer(q.id, { optionIds: [v], skipped: false })
                        }}
                      >
                        <Stack gap={6}>
                          {q.options.map((o) => (
                            <Radio
                              key={o.id}
                              value={o.id}
                              label={o.label}
                              description={o.description || undefined}
                            />
                          ))}
                        </Stack>
                      </Radio.Group>
                    )}
                    {q.allowOther ? (
                      <TextInput
                        size="xs"
                        placeholder="Other…"
                        maxLength={500}
                        value={a?.other ?? ''}
                        onChange={(e) => {
                          setAnswer(q.id, { other: e.currentTarget.value, skipped: false })
                        }}
                      />
                    ) : null}
                  </Stack>
                </Card>
              )
            })}
            <Button
              onClick={() => {
                if (!plan) return
                const list: Answer[] = questions.map((q): Answer => {
                  const a = answers[q.id]
                  const other = a?.other?.trim()
                  if (!a || (!a.optionIds?.length && !other)) return { questionId: q.id, skipped: true }
                  return {
                    questionId: q.id,
                    ...(a.optionIds ? { optionIds: a.optionIds } : {}),
                    ...(other ? { other } : {}),
                  }
                })
                getBrief.mutate({ params: { path: { id: plan.id } }, body: { answers: list } })
              }}
            >
              Done: write the brief
            </Button>
          </Stack>
        ) : null}

        {!busy && plan && !brief && questions.length === 0 && !error ? (
          <Text size="sm" c="var(--va-muted)">
            Your prompt covers it.
          </Text>
        ) : null}

        {brief ? (
          <Stack gap="sm">
            <Text size="sm" c="var(--va-muted)">
              The brief goes to the agent with your prompt. Edit anything.
            </Text>
            <Textarea
              label="Goal"
              autosize
              minRows={2}
              value={brief.goal}
              onChange={(e) => editBrief({ goal: e.currentTarget.value })}
            />
            <TextInput
              label="Audience"
              value={brief.audience}
              onChange={(e) => editBrief({ audience: e.currentTarget.value })}
            />
            <TextInput
              label="Key message"
              value={brief.keyMessage}
              onChange={(e) => editBrief({ keyMessage: e.currentTarget.value })}
            />
            <Stack gap={6}>
              <Text size="sm" fw={500}>
                Beats
              </Text>
              {brief.beats.map((b, i) => (
                <Group key={i} gap="xs" wrap="nowrap">
                  <TextInput
                    style={{ flex: 1 }}
                    value={b.text}
                    onChange={(e) => {
                      const beats = brief.beats.map((x, j) =>
                        j === i ? { ...x, text: e.currentTarget.value } : x,
                      )
                      editBrief({ beats })
                    }}
                  />
                  <NumberInput
                    w={84}
                    min={0}
                    max={600}
                    suffix=" s"
                    value={b.seconds}
                    onChange={(v) => {
                      const beats = brief.beats.map((x, j) =>
                        j === i ? { ...x, seconds: Number(v) || 0 } : x,
                      )
                      editBrief({ beats })
                    }}
                  />
                </Group>
              ))}
            </Stack>
            <TextInput
              label="Tone"
              value={brief.tone}
              onChange={(e) => editBrief({ tone: e.currentTarget.value })}
            />
            <TextInput
              label="Call to action"
              value={brief.callToAction}
              onChange={(e) => editBrief({ callToAction: e.currentTarget.value })}
            />
            <TagsInput
              label="Must include"
              value={brief.mustInclude}
              onChange={(v) => editBrief({ mustInclude: v })}
            />
            <TagsInput label="Avoid" value={brief.avoid} onChange={(v) => editBrief({ avoid: v })} />
          </Stack>
        ) : null}

        <Group gap="sm">
          {brief ? (
            <Button loading={props.creating || save.isPending} onClick={() => void create()}>
              {props.revisionOf ? 'Make the new version' : 'Create video'}
            </Button>
          ) : null}
          <Button
            variant={brief ? 'subtle' : 'default'}
            color="gray"
            loading={props.creating && !brief}
            onClick={() => {
              props.onCreate(null)
            }}
          >
            {brief ? 'Create without the plan' : 'Create now'}
          </Button>
        </Group>
      </Stack>
    </Card>
  )
}
