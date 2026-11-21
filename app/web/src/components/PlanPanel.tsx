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
import { IconChevronDown, IconChevronUp, IconGripVertical, IconPlus, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { $api, errorMessage, fetchClient } from '../api/client'
import type { paths } from '../api/schema'
import type { EngineId } from '../lib/engines'
import { isTyping } from '../lib/media-keys'
import { LookControl } from './LookPicker'
import type { Sound } from './SoundControl'
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
  /** The look picked next to the prompt (null: None); left out, the plan picks one from its template. */
  look?: string | null | undefined
  /** With it, the brief shows the plan's look as a chip that can be changed before creating. */
  onLookChange?: (id: string | null) => void
  /** The engine picked next to the prompt (render-engines plan §4.2); left out, the look's choice. */
  engine?: EngineId | undefined
  /** What that engine can make: the brief's Sound and voice-over follow it (all of them when left out). */
  limits?: { sounds: Sound[]; voiceover: boolean } | undefined
  /** Called with the plan id to create with it, or null to create without a plan. */
  onCreate: (planId: string | null) => void
  onSuggestAspect?: (aspect: Aspect) => void
  onClose: () => void
  creating: boolean
  /** Questions one at a time with a stepper, ending on the brief (the New video dialog); else a side panel. */
  steps?: boolean
}

/** The most scenes a brief takes (planBriefShape in app/server/schemas.ts). */
const MAX_SCENES = 20
/** How often the panel looks at a plan whose questions or brief are being written in the background. */
const POLL_MS = 1200
/** Asks the API to answer at once and let the panel poll, rather than hold the request while the model writes. */
const ASYNC = { Prefer: 'respond-async' }

// What the wait shows, a phrase at a time: each model call takes a few seconds, and the brief up to a minute.
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
function OptionLabel({ o, large }: { o: Question['options'][number]; large?: boolean | undefined }) {
  return (
    <>
      {o.label}
      {o.recommended ? (
        <Text span fw={700} size={large ? 'md' : 'sm'} ml={6} className="va-recommended">
          (Recommended)
        </Text>
      ) : null}
    </>
  )
}

/**
 * One question: its options (one or several), Skip, and free text for another answer or more context. `large` is for
 * the New video dialog, which shows one question at a time with room to spare.
 */
function QuestionCard({
  q,
  a,
  setAnswer,
  large,
}: {
  q: Question
  a: Answer | undefined
  setAnswer: (id: string, patch: Partial<Answer>) => void
  large?: boolean
}) {
  const optionSize = large ? 'md' : 'sm'
  return (
    <Card
      className={large ? 'va-plan-q va-plan-q-large' : 'va-plan-q'}
      padding={large ? 'xl' : 'md'}
      data-testid={`plan-q-${q.id}`}
    >
      <Stack gap={large ? 'md' : 'xs'}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Text fw={600} size={large ? 'xl' : 'sm'} lh={1.3}>
            {q.question}
          </Text>
          <Checkbox
            size={large ? 'sm' : 'xs'}
            label="Skip"
            checked={a?.skipped ?? false}
            onChange={(e) => {
              setAnswer(q.id, { skipped: e.currentTarget.checked })
            }}
          />
        </Group>
        {q.why ? (
          <Text size={large ? 'md' : 'xs'} c="var(--va-faint)">
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
            <Stack gap={large ? 'md' : 6}>
              {q.options.map((o) => (
                <Checkbox
                  key={o.id}
                  value={o.id}
                  size={optionSize}
                  label={<OptionLabel o={o} large={large} />}
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
            <Stack gap={large ? 'md' : 6}>
              {q.options.map((o) => (
                <Radio
                  key={o.id}
                  value={o.id}
                  size={optionSize}
                  label={<OptionLabel o={o} large={large} />}
                  description={o.description || undefined}
                />
              ))}
            </Stack>
          </Radio.Group>
        )}
        {/* Every question takes free text: another answer, or more context on the one picked. */}
        <Textarea
          size={optionSize}
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
  limits,
}: {
  brief: Brief
  /** The person turned the voice-over on before planning. */
  voiceover: boolean
  edit: (patch: Partial<Brief>) => void
  limits?: { sounds: Sound[]; voiceover: boolean } | undefined
}) {
  const spoken = voiceover || brief.voiceover === true
  const beats = brief.beats
  const canAdd = beats.length < MAX_SCENES
  const blank = (): Brief['beats'][number] => ({ text: '', seconds: 5, ...(spoken ? { narration: '' } : {}) })
  /** A new empty scene at position `at` (0: first). */
  const insertScene = (at: number) => {
    edit({ beats: [...beats.slice(0, at), blank(), ...beats.slice(at)] })
  }
  /** Moves scene `from` so it sits before what is now at `to` (beats.length: last). */
  const moveScene = (from: number, to: number) => {
    const target = to > from ? to - 1 : to
    const moved = beats[from]
    if (!moved || target === from) return
    const rest = beats.filter((_, j) => j !== from)
    edit({ beats: [...rest.slice(0, target), moved, ...rest.slice(target)] })
  }
  // Dragging a scene by its handle: the scene picked up, and the gap it would drop into.
  // The ref is what a drop reads (set as the drag starts); the state only draws it.
  const dragFrom = useRef<number | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number | null } | null>(null)
  const endDrag = () => {
    dragFrom.current = null
    setDrag(null)
  }
  /** The gap the pointer is nearest over scene `i`: before it (i) or after it (i + 1). */
  const gapAt = (e: React.DragEvent<HTMLElement>, i: number) => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY < r.top + r.height / 2 ? i : i + 1
  }
  const dropAt =
    drag && drag.to !== null && drag.to !== drag.from && drag.to !== drag.from + 1 ? drag.to : null
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
                    data={(
                      [
                        { value: 'silent', label: 'Silent' },
                        { value: 'music', label: 'Music' },
                        { value: 'music_sfx', label: 'Music + effects' },
                      ] as const
                    ).filter((o) => !limits || limits.sounds.includes(o.value))}
                  />
                ) : null}
                {brief.voiceover !== undefined && (limits?.voiceover ?? true) ? (
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
          <div className="va-brief-scenes" onDragEnd={endDrag}>
            {beats.map((b, i) => {
              const setBeat = (patch: Partial<Brief['beats'][number]>) => {
                edit({ beats: beats.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
              }
              return (
                <div key={i} className="va-brief-slot">
                  {/* One card per scene: its handle, number, length and buttons, then what's shown and what's said. */}
                  <div
                    className="va-brief-scene"
                    data-testid={`brief-scene-${i + 1}`}
                    data-dragging={drag?.from === i || undefined}
                    data-drop={dropAt === i ? 'before' : dropAt === i + 1 ? 'after' : undefined}
                    onDragOver={(e) => {
                      const from = dragFrom.current
                      if (from === null) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      const to = gapAt(e, i)
                      if (to !== drag?.to) setDrag({ from, to })
                    }}
                    onDrop={(e) => {
                      const from = dragFrom.current
                      if (from === null) return
                      e.preventDefault()
                      moveScene(from, gapAt(e, i))
                      endDrag()
                    }}
                  >
                    <Group justify="space-between" wrap="nowrap" gap="xs">
                      <Group gap={4} wrap="nowrap">
                        {beats.length > 1 ? (
                          <span
                            className="va-brief-grip"
                            draggable
                            title="Drag to reorder"
                            aria-hidden
                            data-testid={`brief-scene-grip-${i + 1}`}
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = 'move'
                              e.dataTransfer.setData('text/plain', `Scene ${i + 1}`)
                              const card = e.currentTarget.closest('.va-brief-scene')
                              if (card) e.dataTransfer.setDragImage(card, 16, 16)
                              dragFrom.current = i
                              // After the browser has taken its picture of the card: a card restyled during
                              // dragstart can end the drag before it starts.
                              setTimeout(() => {
                                setDrag({ from: i, to: null })
                              }, 0)
                            }}
                          >
                            <IconGripVertical size={16} />
                          </span>
                        ) : null}
                        <Text size="sm" fw={600} className="num">
                          Scene {i + 1}
                        </Text>
                      </Group>
                      <Group gap={2} wrap="nowrap">
                        <NumberInput
                          size="xs"
                          w={76}
                          mr={4}
                          min={0}
                          max={600}
                          suffix=" s"
                          aria-label={`Length of scene ${i + 1}`}
                          value={b.seconds}
                          onChange={(v) => {
                            setBeat({ seconds: Number(v) || 0 })
                          }}
                        />
                        {beats.length > 1 ? (
                          <>
                            {/* The same move without dragging: for the keyboard and for touch screens. */}
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              aria-label={`Move scene ${i + 1} up`}
                              disabled={i === 0}
                              onClick={() => {
                                moveScene(i, i - 1)
                              }}
                            >
                              <IconChevronUp size={16} />
                            </ActionIcon>
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              aria-label={`Move scene ${i + 1} down`}
                              disabled={i === beats.length - 1}
                              onClick={() => {
                                moveScene(i, i + 2)
                              }}
                            >
                              <IconChevronDown size={16} />
                            </ActionIcon>
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              aria-label={`Remove scene ${i + 1}`}
                              onClick={() => {
                                edit({ beats: beats.filter((_, j) => j !== i) })
                              }}
                            >
                              <IconX size={16} />
                            </ActionIcon>
                          </>
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
                  {/* Between two scenes: a plus that puts a new one there. */}
                  {i < beats.length - 1 ? (
                    <div className="va-brief-insert">
                      {canAdd ? (
                        <ActionIcon
                          variant="default"
                          size="sm"
                          radius="xl"
                          aria-label={`Insert a scene after scene ${i + 1}`}
                          title="Insert a scene here"
                          onClick={() => {
                            insertScene(i + 1)
                          }}
                        >
                          <IconPlus size={14} />
                        </ActionIcon>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
          {canAdd ? (
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPlus size={14} />}
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                insertScene(beats.length)
              }}
            >
              Add scene
            </Button>
          ) : (
            <Text size="xs" c="var(--va-faint)">
              A brief takes up to {MAX_SCENES} scenes. Remove one to add another.
            </Text>
          )}
        </Stack>
      </div>
    </Stack>
  )
}

/**
 * The plan's look on the brief (looks plan §6): a chip showing what the video will be made in, changeable before the
 * run. The person's own pick (value) wins over the plan's; nothing shows for a plan that keeps its video's look.
 */
function PlanLookChip(props: {
  plan: Plan | null | undefined
  value: string | null | undefined
  onChange: ((id: string | null) => void) | undefined
}) {
  if (!props.onChange || !props.plan?.look) return null
  return (
    <div data-testid="plan-look">
      <LookControl
        value={props.value !== undefined ? props.value : props.plan.look.id}
        onChange={props.onChange}
        template={props.plan.route?.template}
        label="Look"
        hint={
          props.plan.look.chosen || props.value !== undefined
            ? undefined
            : 'Picked for this kind of video. Change it if you like.'
        }
      />
    </div>
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

  // The questions and the brief are written in the background: the POST answers at once with the plan's work
  // "running", and the panel polls the plan until they're there (or the work failed).
  const [writing, setWriting] = useState<'questions' | 'brief' | null>(null)
  const open = useRef(true)
  useEffect(
    () => () => {
      open.current = false
    },
    [],
  )
  /** The plan once its running work is done; null when the panel closed while waiting. Failed work is thrown. */
  const written = async (started: Plan): Promise<Plan | null> => {
    let p = started
    let misses = 0
    while (p.work?.status === 'running') {
      await new Promise((r) => setTimeout(r, POLL_MS))
      if (!open.current) return null
      const res = await fetchClient
        .GET('/api/v1/plans/{id}', { params: { path: { id: p.id } } })
        .catch(() => null)
      if (res?.data) {
        p = res.data
        misses = 0
        // One missed poll is nothing (a dropped connection); several in a row is an answer.
      } else if (++misses >= 5) throw new Error("Can't reach the server. Try again.")
    }
    if (p.work?.status === 'failed')
      // The shape of an API error, so it reads like one that came back from the request.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw {
        error: { code: 'planning_unavailable', message: p.work.error ?? 'Planning failed. Try again.' },
      }
    return p
  }
  const wait = (kind: 'questions' | 'brief', started: Plan, then: (p: Plan) => void) => {
    setWriting(kind)
    written(started)
      .then((p) => {
        if (!p) return
        setWriting(null)
        then(p)
      })
      .catch((e: unknown) => {
        if (!open.current) return
        setWriting(null)
        onError(e)
      })
  }

  const getBrief = $api.useMutation('post', '/api/v1/plans/{id}/brief', {
    onSuccess: (started) => {
      wait('brief', started, (p) => {
        setPlan(p)
        setBrief(p.brief)
        setEdited(false)
        setStep((p.questions ?? []).length)
      })
    },
    onError,
  })
  const askBrief = (id: string, list: Answer[]) => {
    setError(null)
    getBrief.mutate({ params: { path: { id } }, body: { answers: list }, headers: ASYNC })
  }
  const getQuestions = $api.useMutation('post', '/api/v1/plans/{id}/questions', {
    onSuccess: (started) => {
      wait('questions', started, (p) => {
        setPlan(p)
        // The prompt covers it: go straight to the brief.
        if ((p.questions ?? []).length === 0) askBrief(p.id, [])
      })
    },
    onError,
  })
  const askQuestions = (id: string) => {
    setError(null)
    getQuestions.mutate({ params: { path: { id } }, headers: ASYNC })
  }
  const start = $api.useMutation('post', '/api/v1/plans', {
    onSuccess: (p) => {
      setPlan(p)
      if (p.route?.suggestedAspect && !props.aspect) props.onSuggestAspect?.(p.route.suggestedAspect)
      askQuestions(p.id)
    },
    onError,
  })
  const save = $api.useMutation('patch', '/api/v1/plans/{id}', { onError })

  const startPlan = () => {
    setError(null)
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
        ...(props.look !== undefined ? { look: props.look } : {}),
        ...(props.engine ? { engine: props.engine } : {}),
      },
    })
  }
  // Start once per panel; the prompt is fixed while planning.
  useEffect(startPlan, [])

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

  const busy = start.isPending || getQuestions.isPending || getBrief.isPending || writing !== null
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
    askBrief(plan.id, list)
  }
  /** Runs the step that failed again: the plan, its questions, or the brief from the same answers. */
  const retry = () => {
    if (!plan) startPlan()
    else if (!plan.questions) askQuestions(plan.id)
    else askBrief(plan.id, answerList())
  }

  const phrase = useRotating(
    start.isPending
      ? READING
      : getQuestions.isPending || writing === 'questions'
        ? ASKING
        : plan?.voiceover
          ? [...WRITING.slice(0, 4), ...NARRATING, ...WRITING.slice(4)]
          : WRITING,
    busy,
  )
  const status = busy ? (
    props.steps ? (
      // The dialog has the room: the wait sits in the middle of it, large enough to read at a glance.
      <Stack gap="lg" align="center" justify="center" className="va-plan-wait" role="status">
        <Loader size="xl" />
        <Text key={phrase} size="xl" fw={500} ta="center" c="var(--va-muted)" className="va-phrase">
          {phrase}
        </Text>
      </Stack>
    ) : (
      <Group gap="sm" role="status">
        <Loader size="sm" />
        <Text key={phrase} size="sm" c="var(--va-muted)" className="va-phrase">
          {phrase}
        </Text>
      </Group>
    )
  ) : null
  const problem = error ? (
    <Alert color={error.unavailable ? 'gray' : 'red'} variant="light">
      <Group justify="space-between" gap="sm" wrap="nowrap">
        <Text size={props.steps ? 'md' : 'sm'}>{error.message}</Text>
        <Button variant="default" size="compact-sm" style={{ flexShrink: 0 }} onClick={retry}>
          Try again
        </Button>
      </Group>
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
      if (isTyping(e.target)) return
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
              large
            />
          ) : brief ? (
            <>
              <PlanLookChip plan={plan} value={props.look} onChange={props.onLookChange} />
              <BriefEditor
                brief={brief}
                voiceover={!!plan?.voiceover}
                edit={editBrief}
                limits={props.limits}
              />
            </>
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

        {brief ? (
          <>
            <PlanLookChip plan={plan} value={props.look} onChange={props.onLookChange} />
            <BriefEditor brief={brief} voiceover={!!plan?.voiceover} edit={editBrief} limits={props.limits} />
          </>
        ) : null}

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
