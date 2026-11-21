import {
  ActionIcon,
  Anchor,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core'
import { TagsField } from '../components/TagsField'
import { useMediaQuery } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import {
  IconArrowsShuffle,
  IconBolt,
  IconCopy,
  IconListCheck,
  IconScreenShare,
  IconX,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { $api, errorMessage, newIdempotencyKey, useCanCreate, type Version, type Video } from '../api/client'
import { PageHeader, Status, VersionImage, relativeTime } from '../components/bits'
import { MediaChips, type Media } from '../components/MediaPicker'
import { LookControl, shownLook, useLooks } from '../components/LookPicker'
import { pickable } from '../lib/looks'
import { useNewVideoTools } from '../webmcp/newVideoTools'
import {
  capabilitiesOf,
  engineName,
  resolveEngine,
  soundsFor,
  useEngines,
  type EngineId,
} from '../lib/engines'
import { PlanPanel } from '../components/PlanPanel'
import { RecordScreenButton } from '../components/recording/RecordScreenButton'
import type { AttachedRecording } from '../lib/demo-setup'
import { RemixForm, RemixSourcePicker, latestReady, useCanRemix } from '../components/RemixDialog'
import { SoundControl, soundAfterPick, type Sound } from '../components/SoundControl'
import { VOICE_OFF, VoiceoverControl, voiceInput, type VoiceState } from '../components/VoiceoverControl'
import { brand } from '../theme'

const EXAMPLES = [
  'A 20-second launch video for our new webhooks feature: what it is, one example event, and an end card with "Available today".',
  'A vertical 15-second clip for sales: "Preview every pull request" in three quick scenes, ending with "Book a demo".',
  'A one-minute docs tutorial: how to add an environment variable to a project and redeploy it, in three steps.',
]

const SHAPES = [
  { value: '16:9', label: 'Landscape', note: 'Web, slides, YouTube', w: 48, h: 27 },
  { value: '9:16', label: 'Vertical', note: 'Reels, Shorts, TikTok', w: 18, h: 32 },
  { value: '1:1', label: 'Square', note: 'Feeds', w: 30, h: 30 },
  { value: '4:5', label: 'Portrait', note: 'LinkedIn, Instagram', w: 26, h: 32 },
] as const
type Shape = (typeof SHAPES)[number]['value']

function useCreate() {
  const navigate = useNavigate()
  const [key] = useState(newIdempotencyKey)
  const qc = useQueryClient()
  const create = $api.useMutation('post', '/api/v1/videos', {
    onSuccess: (v) => {
      void qc.invalidateQueries()
      void navigate(`/videos/${v.id}`)
    },
    onError: (e) =>
      notifications.show({ color: 'red', title: "Couldn't start the video", message: errorMessage(e) }),
  })
  return { create, key }
}

/** First run in an empty library: the composer where the videos will appear. */
export function QuickCreate() {
  const [prompt, setPrompt] = useState('')
  const { create, key } = useCreate()
  return (
    <Card>
      <Stack gap="md" maw={760}>
        <Title order={2}>Make the first video</Title>
        <Textarea
          aria-label="What should the video show?"
          autosize
          minRows={3}
          placeholder="Who it's for, the message, any exact words to show, and how it should end"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.currentTarget.value)
          }}
        />
        <Group>
          <Button
            disabled={prompt.trim().length < 10}
            loading={create.isPending}
            onClick={() => {
              create.mutate({ body: { prompt }, params: { header: { 'idempotency-key': key } } })
            }}
          >
            Make it
          </Button>
          <Text size="sm" c="var(--va-muted)">
            Usually ready in 3 to 8 minutes.{' '}
            <Link to="/new" style={{ color: 'inherit' }}>
              More options
            </Link>
          </Text>
        </Group>
        <Text size="sm" c="var(--va-muted)" mt="sm">
          Start from one of these
        </Text>
        <Stack gap={8}>
          {EXAMPLES.map((e) => (
            <UnstyledButton
              key={e}
              className="va-raised"
              p="sm"
              onClick={() => {
                setPrompt(e)
              }}
            >
              <Text size="sm">{e}</Text>
            </UnstyledButton>
          ))}
        </Stack>
      </Stack>
    </Card>
  )
}

/** Your last few videos, to reuse a prompt or check on one in progress. */
/** Your last few videos; each ready one can be remixed here (onRemix turns this page into the remix form). */
function RecentMine({ onRemix }: { onRemix: ((video: Video, version: Version) => void) | null }) {
  const mine = $api.useQuery('get', '/api/v1/videos', { params: { query: { owner: 'me', limit: 8 } } })
  const items = mine.data?.items ?? []
  return (
    <Card>
      <Text fw={600} mb="sm">
        Your recent videos
      </Text>
      {items.length === 0 ? (
        <div className="va-empty">{mine.isLoading ? 'Loading…' : 'None yet. This will be your first.'}</div>
      ) : (
        <Stack gap={4}>
          {items.map((v) => {
            const ready = latestReady(v)
            return (
              <div key={v.id} className="va-recent">
                <Link to={`/videos/${v.id}`} className="va-version" style={{ textDecoration: 'none' }}>
                  <div className="va-poster">
                    {ready ? <VersionImage videoId={v.id} v={ready} file="poster" sizes="112px" /> : null}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500} truncate>
                      {v.title}
                    </Text>
                    <Group gap={8} mt={2}>
                      <Status status={v.status} size="xs" />
                      <Text size="xs" c="var(--va-faint)">
                        {relativeTime(v.createdAt)}
                      </Text>
                    </Group>
                  </div>
                </Link>
                {onRemix && ready ? (
                  <Tooltip label={`Remix: a new video from ${v.title}`}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size={32}
                      aria-label={`Remix ${v.title}`}
                      title={`Remix: make a new video from ${v.title}, changed as you describe`}
                      onClick={() => {
                        onRemix(v, ready)
                      }}
                    >
                      <IconArrowsShuffle size={16} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </div>
            )
          })}
        </Stack>
      )}
    </Card>
  )
}

/** m:ss */
const clock = (s: number) => `${String(Math.floor(s / 60))}:${String(Math.round(s % 60)).padStart(2, '0')}`

export function NewVideoPage() {
  const [prompt, setPrompt] = useState('')
  const [shape, setShape] = useState<Shape>('16:9')
  const [lengthMode, setLengthMode] = useState<'auto' | 'set'>('auto')
  const [seconds, setSeconds] = useState<number | string>(30)
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [media, setMedia] = useState<Media[]>([])
  // A screen recording made with Record screen, set up (trim, crop, hide) and added to this form.
  const [recording, setRecording] = useState<AttachedRecording | null>(null)
  const [sound, setSound] = useState<Sound>('silent')
  const [soundTouched, setSoundTouched] = useState(false)
  const [voice, setVoice] = useState<VoiceState>(VOICE_OFF)
  // Undefined until the person picks: the request then leaves look out and the admin default applies.
  const [look, setLook] = useState<string | null | undefined>(undefined)
  const { create, key } = useCreate()
  const config = $api.useQuery('get', '/api/v1/config')
  const canPlan = useCanCreate() && config.data?.planningAvailable === true
  // The Create dialog: choosing how to start, then the plan's questions and brief as steps.
  const [dialog, setDialog] = useState<null | 'choose' | 'plan'>(null)
  const planning = dialog === 'plan'
  const phone = useMediaQuery('(max-width: 48em)')
  const [shapeTouched, setShapeTouched] = useState(false)
  // Start from an existing video (a remix, docs/plans/2026-11-03-remix.md §3.7).
  const canRemix = useCanRemix()
  const [pickingSource, setPickingSource] = useState(false)
  const [remixFrom, setRemixFrom] = useState<{ video: Video; version: Version } | null>(null)
  const valid =
    prompt.trim().length >= 10 && prompt.length <= 4000 && (lengthMode === 'auto' || Number(seconds) >= 3)
  // The engine (render-engines plan §4.2): the look's choice unless the person picks another. With only HyperFrames on
  // here, none of this shows and no engines request is made.
  const { engines, enabled } = useEngines()
  const shownLookEntry = shownLook(useLooks(), look)
  const [engineAsked, setEngineAsked] = useState<EngineId | null>(null)
  const engine = resolveEngine(shownLookEntry, enabled, engineAsked)
  const engineChoices = (shownLookEntry?.engines ?? enabled).filter((e) => enabled.includes(e))
  const caps = capabilitiesOf(engines, engine)
  const sounds = soundsFor(caps)
  const voiceAllowed = caps?.voiceover ?? true
  const extraCredits = engines?.find((e) => e.id === engine)?.extraCredits ?? null
  // What's sent: a sound or voice-over the engine can't make is never asked for.
  const sentSound: Sound = sounds.includes(sound) ? sound : 'music'
  const sentVoice = voiceAllowed && voice.enabled

  // A Sound the person set (or that picking an audio file set): otherwise a plan takes it from the request.
  const chosenSound = soundTouched || sound !== 'silent' ? sentSound : undefined

  const submit = (planId: string | null = null) => {
    create.mutate({
      body: {
        prompt,
        aspect: shape,
        ...(lengthMode === 'set' ? { durationSec: Number(seconds) } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(tags.length ? { tags } : {}),
        ...(planId ? { planId } : {}),
        ...(media.length ? { mediaIds: media.map((m) => m.id) } : {}),
        // With a plan, an untouched Sound is the plan's (from the request); without one there's nothing else to go on.
        ...(planId && !chosenSound ? {} : { sound: sentSound }),
        // A plan carries the voice-over (with its narration), so only a direct create sends it.
        ...(sentVoice && !planId ? { voiceover: voiceInput(voice) } : {}),
        ...(look !== undefined ? { look } : {}),
        // A screen recording makes the video a demo of it, with its trim, crop and hidden areas (HyperFrames only).
        ...(recording
          ? { recording: recording.input, ...(planId ? {} : { engine: 'hyperframes' as const }) }
          : // Only a choice the person made; a plan already carries its own.
            engineAsked === engine && !planId
            ? { engine }
            : {}),
      },
      params: { header: { 'idempotency-key': key } },
    })
  }

  // WebMCP (va-qago): an agent fills the same form, and creates through the same request as Create it now.
  const lookIds = pickable(useLooks()?.looks ?? []).map((l) => l.id)
  useNewVideoTools({
    canCreate: useCanCreate(),
    looks: lookIds,
    fill: (f) => {
      setPrompt(f.prompt)
      if (f.aspect) {
        setShape(f.aspect)
        setShapeTouched(true)
      }
      setLengthMode(f.duration_sec ? 'set' : 'auto')
      if (f.duration_sec) setSeconds(f.duration_sec)
      setTitle(f.title ?? '')
      if (f.look !== undefined) setLook(f.look)
      setSound(f.sound ?? 'silent')
      setSoundTouched(f.sound !== undefined)
      setVoice(
        f.voiceover ? { enabled: true, voice: f.voice ?? '', speed: 1, script: f.script ?? [] } : VOICE_OFF,
      )
    },
    create: async (f) => {
      const v = await create.mutateAsync({
        body: {
          prompt: f.prompt,
          aspect: f.aspect ?? '16:9',
          ...(f.duration_sec ? { durationSec: f.duration_sec } : {}),
          ...(f.title?.trim() ? { title: f.title.trim() } : {}),
          ...(tags.length ? { tags } : {}),
          ...(media.length ? { mediaIds: media.map((m) => m.id) } : {}),
          sound: f.sound ?? 'silent',
          ...(f.voiceover
            ? {
                voiceover: voiceInput({
                  enabled: true,
                  voice: f.voice ?? '',
                  speed: 1,
                  script: f.script ?? [],
                }),
              }
            : {}),
          ...(f.look !== undefined ? { look: f.look } : {}),
        },
        params: { header: { 'idempotency-key': key } },
      })
      return v.id
    },
  })

  const picker = (
    <RemixSourcePicker
      opened={pickingSource}
      onClose={() => {
        setPickingSource(false)
      }}
      onPick={(video, version) => {
        setRemixFrom({ video, version })
        setPickingSource(false)
      }}
    />
  )
  if (remixFrom)
    return (
      <>
        <PageHeader
          title="New video"
          sub={
            <>
              Starting from {remixFrom.video.title} v{remixFrom.version.n}. Say what should be different.
            </>
          }
        />
        <Card maw={720}>
          <RemixForm
            key={`${remixFrom.video.id}-${remixFrom.version.n}`}
            video={remixFrom.video}
            version={remixFrom.version}
            footer={
              <Group gap="xs">
                <Anchor
                  component="button"
                  type="button"
                  size="sm"
                  onClick={() => {
                    setPickingSource(true)
                  }}
                >
                  Pick another video
                </Anchor>
                <Text size="sm" c="var(--va-faint)">
                  ·
                </Text>
                <Anchor
                  component="button"
                  type="button"
                  size="sm"
                  onClick={() => {
                    setRemixFrom(null)
                  }}
                >
                  Start from scratch
                </Anchor>
              </Group>
            }
          />
        </Card>
        {picker}
      </>
    )

  return (
    <>
      <PageHeader
        title="New video"
        sub={
          // The other ways to start sit right after the sentence, as separate buttons (they wrap under it when narrow).
          <Group gap="xs" wrap="wrap" align="center">
            <span>Describe it once. The agent writes, checks and renders it, usually in 3 to 8 minutes.</span>
            {canRemix ? (
              <Button
                variant="default"
                size="compact-sm"
                leftSection={<IconCopy size={15} />}
                onClick={() => {
                  setPickingSource(true)
                }}
              >
                Start from an existing video
              </Button>
            ) : null}
            {config.data?.features.includes('screen_recording') ? (
              <Button
                component={Link}
                to="/new/demo"
                variant="default"
                size="compact-sm"
                leftSection={<IconScreenShare size={15} />}
              >
                From a screen recording
              </Button>
            ) : null}
          </Group>
        }
      />
      {picker}
      <div className="va-split">
        {/* Not clipped, so the actions row can stick to the window's bottom edge. */}
        <Card style={{ overflow: 'visible' }}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!valid || config.isPending) return
              if (canPlan) setDialog('choose')
              else submit()
            }}
          >
            <Stack gap="lg">
              <Textarea
                label="What should the video show?"
                description="Who it's for, the one message, any exact words to show on screen, and how it should end."
                placeholder="Describe what you want to see. For example: a 30-second launch video for our new webhooks feature, for developers, ending on “Try it today”."
                autosize
                minRows={6}
                maxLength={4000}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.currentTarget.value)
                }}
                data-autofocus
                autoFocus
              />
              <Text size="xs" c="var(--va-faint)" ta="right" mt={-16} className="num">
                {prompt.length} / 4,000
              </Text>
              <MediaChips
                value={media}
                onChange={(next) => {
                  setSound(soundAfterPick(sound, soundTouched, media, next))
                  setMedia(next)
                }}
                disabled={planning}
                // A screen recording made here sits with the picked media; Create video sends it as `recording`.
                chips={
                  recording ? (
                    <span className="va-media-chip" data-testid="chip-recording" style={{ maxWidth: 320 }}>
                      {recording.poster ? (
                        <img src={recording.poster} alt="" />
                      ) : (
                        <IconScreenShare size={14} />
                      )}
                      <span className="va-media-chip-name">
                        Screen recording · {clock(recording.usedSec)}
                        {recording.cropped ? ' · cropped' : ''}
                        {recording.boxes ? ` · ${String(recording.boxes)} hidden` : ''}
                      </span>
                      {planning ? null : (
                        <ActionIcon
                          size="xs"
                          variant="subtle"
                          color="gray"
                          aria-label="Remove the screen recording"
                          onClick={() => {
                            setRecording(null)
                          }}
                        >
                          <IconX size={12} />
                        </ActionIcon>
                      )}
                    </span>
                  ) : null
                }
                extra={
                  config.data?.features.includes('screen_recording') ? (
                    <RecordScreenButton aspect={shape} disabled={planning} onAttach={setRecording} />
                  ) : null
                }
              />
              {recording ? (
                <Text size="xs" c="var(--va-muted)" data-testid="recording-note">
                  With a screen recording, the video is a demo of it: the agent turns its steps into scenes
                  with zooms and a cursor, around what you describe. It&apos;s made with HyperFrames
                  {recording.hides ? ', and starts private because something is hidden' : ''}.
                </Text>
              ) : null}
              <div>
                <Text size="sm" fw={500} mb={8} id="shape-label">
                  Shape
                </Text>
                <div
                  role="radiogroup"
                  aria-labelledby="shape-label"
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}
                >
                  {SHAPES.map((s) => {
                    const on = shape === s.value
                    return (
                      <UnstyledButton
                        key={s.value}
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          setShape(s.value)
                          setShapeTouched(true)
                        }}
                        className="va-raised"
                        p="sm"
                        style={{ outline: on ? '2px solid var(--va-text)' : 'none', outlineOffset: -2 }}
                      >
                        <Stack gap={8} align="center">
                          <div style={{ height: 34, display: 'grid', placeItems: 'center' }}>
                            <div
                              style={{
                                width: s.w,
                                height: s.h,
                                borderRadius: 2,
                                border: `2px solid ${on ? 'var(--va-text)' : 'var(--va-faint)'}`,
                              }}
                            />
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <Text size="sm" fw={500}>
                              {s.label}{' '}
                              <span className="num" style={{ color: 'var(--va-muted)', fontWeight: 400 }}>
                                {s.value}
                              </span>
                            </Text>
                            <Text size="xs" c="var(--va-faint)" visibleFrom="sm">
                              {s.note}
                            </Text>
                          </div>
                        </Stack>
                      </UnstyledButton>
                    )
                  })}
                </div>
              </div>
              <Group align="end" gap="sm">
                <div>
                  <Text size="sm" fw={500} mb={8}>
                    Length
                  </Text>
                  <SegmentedControl
                    value={lengthMode}
                    onChange={(v) => {
                      setLengthMode(v)
                    }}
                    data={[
                      { label: 'Let the agent decide', value: 'auto' },
                      { label: 'Set a target', value: 'set' },
                    ]}
                  />
                </div>
                {lengthMode === 'set' ? (
                  <NumberInput
                    aria-label="Target length in seconds"
                    min={3}
                    value={seconds}
                    onChange={setSeconds}
                    w={140}
                    suffix=" s"
                    radius="xl"
                  />
                ) : null}
              </Group>
              <SoundControl
                value={sentSound}
                media={media}
                disabled={planning}
                allowed={sounds}
                onChange={(s) => {
                  setSound(s)
                  setSoundTouched(true)
                }}
              />
              {voiceAllowed ? (
                <VoiceoverControl value={voice} onChange={setVoice} disabled={planning} planning={canPlan} />
              ) : null}
              <LookControl
                value={look}
                onChange={setLook}
                disabled={planning}
                label="What style / look should the video have?"
              />
              {engineChoices.length > 1 ? (
                <Select
                  label="Engine"
                  description="What renders the video. The look picks one; change it only if you need to."
                  data={engineChoices.map((e) => ({ value: e, label: engineName(e) }))}
                  value={engine}
                  allowDeselect={false}
                  disabled={planning}
                  onChange={(v) => {
                    setEngineAsked(v)
                  }}
                  data-testid="engine-select"
                />
              ) : null}
              {extraCredits !== null && engine !== 'hyperframes' ? (
                <Text size="xs" c="var(--va-faint)" data-testid="engine-credits">
                  {engineName(engine)} videos take about {extraCredits} more credits.
                </Text>
              ) : null}
              <TextInput
                label="Title"
                description="Optional. The agent names it otherwise."
                maxLength={120}
                value={title}
                onChange={(e) => {
                  setTitle(e.currentTarget.value)
                }}
              />
              <TagsField
                value={tags}
                onChange={setTags}
                description="Optional. Labels like demo, to filter the library by."
              />
              {/* Sticks to the bottom of the window while the form scrolls, so Create video is always in reach. */}
              <Group className="va-sticky-actions">
                {/* Waits for the config: before it loads, a click would skip the choice and create at once. */}
                <Button
                  type="submit"
                  size="md"
                  disabled={!valid || config.isPending}
                  loading={create.isPending && !dialog}
                >
                  Create video
                </Button>
              </Group>
            </Stack>
          </form>
        </Card>
        <div className="va-rail">
          <Card>
            <Text fw={600} mb={8}>
              {brand.isDefault ? 'Brand context: the neutral default' : `${brand.name} brand context`}
            </Text>
            <Text size="sm" c="var(--va-muted)">
              {brand.isDefault
                ? 'Videos use a neutral look until an admin fills in context/ with your brand guide, logos and fonts.'
                : 'Every video follows the brand guide, logos and fonts in context/. Ask for something different in the prompt when you need to.'}
            </Text>
          </Card>
          <Card>
            <Text fw={600} mb={8}>
              Prompts that work
            </Text>
            <Stack gap={10}>
              <Text size="sm" c="var(--va-muted)">
                Quote the exact words you want on screen. The agent keeps quoted text as written.
              </Text>
              <Text size="sm" c="var(--va-muted)">
                Say the audience and the one thing they should remember.
              </Text>
              <Text size="sm" c="var(--va-muted)">
                Describe the ending: an end card, a call to action, a URL.
              </Text>
              <Text size="sm" c="var(--va-muted)">
                Videos have captions and are silent unless you choose Music or a Voice-over. With a
                voice-over, the captions follow the spoken words.
              </Text>
            </Stack>
          </Card>
          <RecentMine
            onRemix={
              canRemix
                ? (video, version) => {
                    setRemixFrom({ video, version })
                    window.scrollTo({ top: 0 })
                  }
                : null
            }
          />
        </div>
      </div>
      <Modal
        opened={dialog !== null}
        onClose={() => {
          setDialog(null)
        }}
        title={dialog === 'plan' ? 'Plan your video' : 'Create your video'}
        // Planning shows a question or a long brief at a time: most of the window, so neither is cramped.
        size={dialog === 'plan' ? '92%' : 'lg'}
        padding={phone ? 'md' : 'xl'}
        fullScreen={phone}
        closeButtonProps={{ 'aria-label': 'Close' }}
        centered
      >
        {dialog === 'plan' ? (
          <PlanPanel
            steps
            prompt={prompt}
            aspect={shapeTouched ? shape : undefined}
            durationSec={lengthMode === 'set' ? Number(seconds) : undefined}
            mediaIds={media.map((m) => m.id)}
            sound={chosenSound}
            voiceover={sentVoice ? voiceInput(voice) : undefined}
            look={look}
            onLookChange={setLook}
            engine={engineAsked === engine ? engine : undefined}
            limits={{ sounds, voiceover: voiceAllowed }}
            creating={create.isPending}
            onSuggestAspect={(a) => {
              setShape(a)
            }}
            onClose={() => {
              setDialog(null)
            }}
            onCreate={(planId) => {
              submit(planId)
            }}
          />
        ) : (
          <div className="va-create-choice">
            <UnstyledButton
              className="va-raised va-choice"
              p="lg"
              onClick={() => {
                setDialog('plan')
              }}
            >
              <IconListCheck size={22} />
              <Text fw={600} mt="sm">
                Plan it first
              </Text>
              <Text size="sm" c="var(--va-muted)" mt={4}>
                Answer a few quick questions about the audience and message, then check a short brief before
                the agent starts.
              </Text>
            </UnstyledButton>
            <UnstyledButton
              className="va-raised va-choice"
              p="lg"
              disabled={create.isPending}
              onClick={() => {
                submit()
              }}
            >
              <IconBolt size={22} />
              <Text fw={600} mt="sm">
                {create.isPending ? 'Starting…' : 'Create it now'}
              </Text>
              <Text size="sm" c="var(--va-muted)" mt={4}>
                Start straight away from your prompt. Usually ready in 3 to 8 minutes.
              </Text>
            </UnstyledButton>
          </div>
        )}
      </Modal>
    </>
  )
}
