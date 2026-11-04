// Plan with questions (plan v2 §4): a fast router decides whether questions would help; the person answers (or
// skips), gets an editable brief, and creates the video with it. Create now is always there, and leaving keeps the
// prompt. As a side panel (revisions) the questions are listed together; in the New video dialog they're steps.
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  NumberInput,
  Radio,
  SegmentedControl,
  Stack,
  Stepper,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import { IconPlus, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { $api, errorMessage } from '../api/client'
import type { paths } from '../api/schema'
import type { VoiceoverInput } from './VoiceoverControl'

type Plan = paths['/api/v1/plans/{id}']['get']['responses'][200]['content']['application/json']
type Brief = NonNullable<Plan['brief']>
type Question = NonNullable<Plan['questions']>[number]
type Answer = { questionId: string; optionIds?: string[]; other?: string; skipped?: boolean }
type Aspect = '16:9' | '9:16' | '1:1' | '4:5'

export interface PlanPanelProps {
  prompt: string
  aspect?: Aspect | undefined
  durationSec?: number | undefined
  revisionOf?: { videoId: string; version?: number } | undefined
  /** A remix plan: a new video from this video and version (docs/plans/2026-11-03-remix.md). */
  remixOf?: { videoId: string; version?: number } | undefined
  /** Library items to plan around; the planner sees the images. */
  mediaIds?: string[] | undefined
  /** The Sound chosen next to the prompt; the planner plans for it. */
  sound?: 'silent' | 'music' | 'music_sfx' | undefined
  /** The voice-over chosen next to the prompt; the brief then has a narration line per beat. */
  voiceover?: VoiceoverInput | undefined
  /** Called with the plan id to create with it, or null to create without a plan. */
  onCreate: (planId: string | null) => void
  onSuggestAspect?: (aspect: Aspect) => void
  onClose: () => void
  creating: boolean
  /** Questions one at a time with a stepper, ending on the brief (the New video dialog); else a side panel. */
  steps?: boolean
}

// What the wait shows, a phrase at a time: each model call takes a few seconds, and the brief up to twenty.
const READING = [
  'Reading your prompt…',
  'Working out what kind of video it is…',
  'Checking what’s already clear…',
]
const ASKING = [
  'Thinking of a few questions…',
  'Looking for what’s still open…',
  'Skipping what your prompt already answers…',
  'Weighing what would change the video…',
]
const WRITING = [
  'Writing the brief…',
  'Finding the hook…',
  'Sketching the scenes…',
  'Timing each scene…',
  'Choosing the tone…',
  'Writing the call to action…',
  'Checking it against your answers…',
]
const NARRATING = ['Writing the narration…', 'Fitting each line to its scene…']
/** How long each loading phrase stays. */
const PHRASE_MS = 2600

/** Cycles through `phrases` while `active`, starting over when the list changes. */
function useRotating(phrases: string[], active: boolean): string {
  const [i, setI] = useState(0)
  const key = phrases.join('|')
  useEffect(() => {
    setI(0)
    if (!active) return
    const t = setInterval(() => {
      setI((n) => n + 1)
    }, PHRASE_MS)
    return () => {
      clearInterval(t)
    }
  }, [key, active])
  return phrases[i % phrases.length] ?? ''
}

const isUnavailable = (e: unknown) =>
  Boolean(
    e &&
    typeof e === 'object' &&
    'error' in e &&
    (e as { error: { code?: string } }).error.code === 'planning_unavailable',
  )

/** An option's label, with the planner's pick marked. */
function OptionLabel({ o }: { o: Question['options'][number] }) {
  return (
    <>
      {o.label}
      {o.recommended ? (
        <Text span fw={700} size="sm" ml={6} className="va-recommended">
          (Recommended)
        </Text>
      ) : null}
    </>
  )
}

/** One question: its options (one or several), Skip, and free text for another answer or more context. */
function QuestionCard({
  q,
  a,
  setAnswer,
}: {
  q: Question
  a: Answer | undefined
  setAnswer: (id: string, patch: Partial<Answer>) => void
}) {
  return (
    <Card className="va-plan-q" padding="md" data-testid={`plan-q-${q.id}`}>
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
                  label={<OptionLabel o={o} />}
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
                  label={<OptionLabel o={o} />}
                  description={o.description || undefined}
                />
              ))}
            </Stack>
          </Radio.Group>
        )}
        {/* Every question takes free text: another answer, or more context on the one picked. */}
        <Textarea
          size="sm"
          mt={4}
          aria-label={`Other, or more context: ${q.question}`}
          placeholder="Other, or more context…"
          autosize
          minRows={3}
          maxRows={6}
          maxLength={500}
          value={a?.other ?? ''}
          onChange={(e) => {
            setAnswer(q.id, { other: e.currentTarget.value, skipped: false })
          }}
        />
      </Stack>
    </Card>
  )
}

/** The brief the planner wrote, every field editable: the essentials on the left, the scenes on the right. */
function BriefEditor({
  brief,
  voiceover,
  edit,
}: {
  brief: Brief
  /** The person turned the voice-over on before planning. */
  voiceover: boolean
  edit: (patch: Partial<Brief>) => void
}) {
  const spoken = voiceover || brief.voiceover === true
  const decided = brief.sound !== undefined || brief.voiceover !== undefined
  return (
    <Stack gap="sm">
      <Text size="sm" c="var(--va-muted)">
        The brief goes to the agent with your prompt. Edit anything.
      </Text>
      <div className="va-brief">
        <Stack gap="sm">
          <TextInput
            label="Title"
            description="The video's name in the library. You can rename it later."
            maxLength={120}
            value={brief.title ?? ''}
            onChange={(e) => edit({ title: e.currentTarget.value })}
          />
          <Textarea
            label="Goal"
            autosize
            minRows={2}
            value={brief.goal}
            onChange={(e) => edit({ goal: e.currentTarget.value })}
          />
          <Textarea
            label="Audience"
            autosize
            minRows={1}
            value={brief.audience}
            onChange={(e) => edit({ audience: e.currentTarget.value })}
          />
          <Textarea
            label="Key message"
            autosize
            minRows={1}
            value={brief.keyMessage}
            onChange={(e) => edit({ keyMessage: e.currentTarget.value })}
          />
          <TextInput
            label="Tone"
            value={brief.tone}
            onChange={(e) => edit({ tone: e.currentTarget.value })}
          />
          <TextInput
            label="Call to action"
            value={brief.callToAction}
            onChange={(e) => edit({ callToAction: e.currentTarget.value })}
          />
          <TagsInput
            label="Must include"
            value={brief.mustInclude}
            onChange={(v) => edit({ mustInclude: v })}
          />
          <TagsInput label="Avoid" value={brief.avoid} onChange={(v) => edit({ avoid: v })} />
          {decided ? (
            // What the planner took from the request because the form's settings were left as they were.
            <div className="va-brief-audio" data-testid="brief-audio">
              <Text size="sm" fw={500}>
                Sound
              </Text>
              <Text size="xs" c="var(--va-faint)" mb={6}>
                From your request. Change it here.
              </Text>
              <Group gap="md" wrap="wrap">
                {brief.sound !== undefined ? (
                  <SegmentedControl
                    size="xs"
                    aria-label="Sound"
                    value={brief.sound}
                    onChange={(v) => edit({ sound: v })}
                    data={[
                      { value: 'silent', label: 'Silent' },
                      { value: 'music', label: 'Music' },
                      { value: 'music_sfx', label: 'Music + effects' },
                    ]}
                  />
                ) : null}
                {brief.voiceover !== undefined ? (
                  <Switch
                    label="Voice-over"
                    checked={brief.voiceover}
                    onChange={(e) => edit({ voiceover: e.currentTarget.checked })}
                  />
                ) : null}
              </Group>
            </div>
          ) : null}
        </Stack>
        <Stack gap={8}>
          <Text size="sm" fw={500}>
            Scenes
          </Text>
          {spoken ? (
            <Text size="xs" c="var(--va-faint)">
              Each scene's narration is read word for word, and the scene is made long enough for it.
            </Text>
          ) : null}
          {brief.beats.map((b, i) => {
            const setBeat = (patch: Partial<Brief['beats'][number]>) => {
              edit({ beats: brief.beats.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
            }
            return (
              // One card per scene: its number, length and remove button, then what's shown and what's said.
              <div key={i} className="va-brief-scene" data-testid={`brief-scene-${i + 1}`}>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm" fw={600} className="num">
                    Scene {i + 1}
                  </Text>
                  <Group gap={6} wrap="nowrap">
                    <NumberInput
                      size="xs"
                      w={76}
                      min={0}
                      max={600}
                      suffix=" s"
                      aria-label={`Length of scene ${i + 1}`}
                      value={b.seconds}
                      onChange={(v) => {
                        setBeat({ seconds: Number(v) || 0 })
                      }}
                    />
                    {brief.beats.length > 1 ? (
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={`Remove scene ${i + 1}`}
                        onClick={() => {
                          edit({ beats: brief.beats.filter((_, j) => j !== i) })
                        }}
                      >
                        <IconX size={16} />
                      </ActionIcon>
                    ) : null}
                  </Group>
                </Group>
                <Textarea
                  label="On screen"
                  aria-label={`Scene ${i + 1}`}
                  autosize
                  minRows={2}
                  maxLength={300}
                  value={b.text}
                  onChange={(e) => {
                    setBeat({ text: e.currentTarget.value })
                  }}
                />
                {spoken ? (
                  <Textarea
                    label="Narration"
                    aria-label={`Narration for scene ${i + 1}`}
                    placeholder="What the narrator says over this scene"
                    autosize
                    minRows={2}
                    maxLength={600}
                    value={b.narration ?? ''}
                    onChange={(e) => {
                      setBeat({ narration: e.currentTarget.value })
                    }}
                  />
                ) : null}
              </div>
            )
          })}
          {brief.beats.length < 12 ? (
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPlus size={14} />}
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                edit({
                  beats: [...brief.beats, { text: '', seconds: 5, ...(spoken ? { narration: '' } : {}) }],
                })
              }}
            >
              Add scene
            </Button>
          ) : null}
        </Stack>
      </div>
    </Stack>
  )
}

export function PlanPanel(props: PlanPanelProps) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [brief, setBrief] = useState<Brief | null>(null)
  const [edited, setEdited] = useState(false)
  const [error, setError] = useState<{ unavailable: boolean; message: string } | null>(null)
  // Stepper: the question shown (questions.length = the brief), and the answers the brief was written from.
  const [step, setStep] = useState(0)
  const [briefFrom, setBriefFrom] = useState<string | null>(null)
  const onError = (e: unknown) => {
    setError({ unavailable: isUnavailable(e), message: errorMessage(e) })
  }

  const getBrief = $api.useMutation('post', '/api/v1/plans/{id}/brief', {
    onSuccess: (p) => {
      setPlan(p)
      setBrief(p.brief)
      setEdited(false)
      setStep((p.questions ?? []).length)
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
        ...(props.remixOf ? { remixOf: props.remixOf } : {}),
        ...(props.mediaIds?.length ? { mediaIds: props.mediaIds } : {}),
        ...(props.sound ? { sound: props.sound } : {}),
        ...(props.voiceover ? { voiceover: props.voiceover } : {}),
      },
    })
    // Start once per panel; the prompt is fixed while planning.
  }, [])

  const create = async () => {
    if (!plan) return props.onCreate(null)
    if (edited && brief) {
      await save.mutateAsync({
        params: { path: { id: plan.id } },
        body: { brief, briefRev: plan.briefRev },
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
  const answerList = (): Answer[] =>
    questions.map((q): Answer => {
      const a = answers[q.id]
      const other = a?.other?.trim()
      if (!a || a.skipped || (!a.optionIds?.length && !other)) return { questionId: q.id, skipped: true }
      return {
        questionId: q.id,
        ...(a.optionIds ? { optionIds: a.optionIds } : {}),
        ...(other ? { other } : {}),
      }
    })
  const writeBrief = () => {
    if (!plan) return
    const list = answerList()
    // Answers unchanged since the brief was written: keep it, with any edits.
    if (brief && briefFrom === JSON.stringify(list)) {
      setStep(questions.length)
      return
    }
    setBriefFrom(JSON.stringify(list))
    getBrief.mutate({ params: { path: { id: plan.id } }, body: { answers: list } })
  }

  const phrase = useRotating(
    start.isPending
      ? READING
      : getQuestions.isPending
        ? ASKING
        : plan?.voiceover
          ? [...WRITING.slice(0, 4), ...NARRATING, ...WRITING.slice(4)]
          : WRITING,
    busy,
  )
  const status = busy ? (
    <Group gap="sm" py={props.steps ? 'xl' : 0} justify={props.steps ? 'center' : 'flex-start'} role="status">
      <Loader size="sm" />
      <Text key={phrase} size="sm" c="var(--va-muted)" className="va-phrase">
        {phrase}
      </Text>
    </Group>
  ) : null
  const problem = error ? (
    <Alert color={error.unavailable ? 'gray' : 'red'} variant="light">
      {error.message}
    </Alert>
  ) : null
  const createLabel = props.revisionOf
    ? 'Make the new version'
    : props.remixOf
      ? 'Remix with this brief'
      : 'Create with this brief'

  // ← and → move between questions (→ on the last one writes the brief), except while typing in a field. ↑ and ↓
  // still move between a question's options.
  const nav = useRef<{ back: () => void; next: () => void } | null>(null)
  useEffect(() => {
    if (!props.steps) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      if (
        t?.closest('textarea, input:not([type=radio]):not([type=checkbox]), [contenteditable="true"], select')
      )
        return
      if (!nav.current) return
      e.preventDefault()
      if (e.key === 'ArrowLeft') nav.current.back()
      else nav.current.next()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
    }
  }, [props.steps])

  if (props.steps) {
    const onBrief = step >= questions.length
    const next = () => {
      if (step < questions.length - 1) setStep(step + 1)
      else writeBrief()
    }
    nav.current =
      busy || onBrief || questions.length === 0
        ? null
        : {
            back: () => {
              if (step > 0) setStep(step - 1)
            },
            next,
          }
    return (
      <Stack gap="md" className="va-plan-steps" data-testid="plan-steps">
        {problem}
        {questions.length > 0 ? (
          <Stepper
            active={step}
            size="sm"
            // Up to seven steps: short labels on one line (Q1…Q6, Brief), never wrapping to a second row.
            wrap={false}
            allowNextStepsSelect={false}
            onStepClick={(i) => {
              if (!busy) setStep(i)
            }}
          >
            {questions.map((q, i) => (
              <Stepper.Step key={q.id} label={`Q${i + 1}`} aria-label={`Question ${i + 1}`} />
            ))}
            <Stepper.Step label="Brief" />
          </Stepper>
        ) : null}
        {status ??
          (!onBrief && questions[step] ? (
            <QuestionCard
              key={questions[step].id}
              q={questions[step]}
              a={answers[questions[step].id]}
              setAnswer={setAnswer}
            />
          ) : brief ? (
            <BriefEditor brief={brief} voiceover={!!plan?.voiceover} edit={editBrief} />
          ) : null)}
        <Group justify="space-between" gap="sm" className="va-plan-footer">
          <Group gap="md">
            {step > 0 && questions.length > 0 ? (
              <Button
                variant="default"
                disabled={busy}
                onClick={() => {
                  setStep(step - 1)
                }}
              >
                Back
              </Button>
            ) : null}
            {!onBrief && questions.length > 1 ? (
              <Text size="xs" c="var(--va-faint)" visibleFrom="sm" aria-hidden>
                <kbd className="va-kbd">←</kbd> <kbd className="va-kbd">→</kbd> to move between questions
              </Text>
            ) : null}
          </Group>
          <Group gap="sm">
            <Button
              variant="default"
              loading={props.creating && !brief}
              onClick={() => {
                props.onCreate(null)
              }}
            >
              {brief ? 'Create without the plan' : 'Create video now'}
            </Button>
            {!onBrief ? (
              <Button disabled={busy} onClick={next}>
                {step < questions.length - 1 ? 'Next question' : 'Write the brief'}
              </Button>
            ) : brief ? (
              <Button loading={props.creating || save.isPending} onClick={() => void create()}>
                {createLabel}
              </Button>
            ) : null}
          </Group>
        </Group>
      </Stack>
    )
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

        {problem}
        {status}

        {!busy && !brief && questions.length > 0 ? (
          <Stack gap="md">
            {questions.map((q) => (
              <QuestionCard key={q.id} q={q} a={answers[q.id]} setAnswer={setAnswer} />
            ))}
            <Button onClick={writeBrief}>Done: write the brief</Button>
          </Stack>
        ) : null}

        {!busy && plan && !brief && questions.length === 0 && !error ? (
          <Text size="sm" c="var(--va-muted)">
            Your prompt covers it.
          </Text>
        ) : null}

        {brief ? <BriefEditor brief={brief} voiceover={!!plan?.voiceover} edit={editBrief} /> : null}

        <Group gap="sm">
          {brief ? (
            <Button loading={props.creating || save.isPending} onClick={() => void create()}>
              {props.revisionOf ? 'Make the new version' : props.remixOf ? 'Remix' : 'Create video'}
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
