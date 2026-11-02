import {
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { IconBolt, IconListCheck } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { $api, errorMessage, newIdempotencyKey, useCanCreate } from '../api/client'
import { Status, VersionImage, relativeTime } from '../components/bits'
import { MediaChips, type Media } from '../components/MediaPicker'
import { PlanPanel } from '../components/PlanPanel'
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
function RecentMine() {
  const mine = $api.useQuery('get', '/api/v1/videos', { params: { query: { owner: 'me', limit: 4 } } })
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
            const ready = v.versions.find((x) => x.status === 'ready')
            return (
              <Link
                key={v.id}
                to={`/videos/${v.id}`}
                className="va-version"
                style={{ textDecoration: 'none' }}
              >
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
            )
          })}
        </Stack>
      )}
    </Card>
  )
}

export function NewVideoPage() {
  const [prompt, setPrompt] = useState('')
  const [shape, setShape] = useState<Shape>('16:9')
  const [lengthMode, setLengthMode] = useState<'auto' | 'set'>('auto')
  const [seconds, setSeconds] = useState<number | string>(30)
  const [title, setTitle] = useState('')
  const [media, setMedia] = useState<Media[]>([])
  const [sound, setSound] = useState<Sound>('silent')
  const [soundTouched, setSoundTouched] = useState(false)
  const [voice, setVoice] = useState<VoiceState>(VOICE_OFF)
  const { create, key } = useCreate()
  const config = $api.useQuery('get', '/api/v1/config')
  const canPlan = useCanCreate() && config.data?.planningAvailable === true
  // The Create dialog: choosing how to start, then the plan's questions and brief as steps.
  const [dialog, setDialog] = useState<null | 'choose' | 'plan'>(null)
  const planning = dialog === 'plan'
  const phone = useMediaQuery('(max-width: 48em)')
  const [shapeTouched, setShapeTouched] = useState(false)
  const valid =
    prompt.trim().length >= 10 && prompt.length <= 4000 && (lengthMode === 'auto' || Number(seconds) >= 3)

  const submit = (planId: string | null = null) => {
    create.mutate({
      body: {
        prompt,
        aspect: shape,
        ...(lengthMode === 'set' ? { durationSec: Number(seconds) } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(planId ? { planId } : {}),
        ...(media.length ? { mediaIds: media.map((m) => m.id) } : {}),
        sound,
        // A plan carries the voice-over (with its narration), so only a direct create sends it.
        ...(voice.enabled && !planId ? { voiceover: voiceInput(voice) } : {}),
      },
      params: { header: { 'idempotency-key': key } },
    })
  }

  return (
    <>
      <div className="va-title-row">
        <div>
          <Title order={1}>New video</Title>
          <div className="va-sub">
            Describe it once. The agent writes, checks and renders it, usually in 3 to 8 minutes.
          </div>
        </div>
      </div>
      <div className="va-split">
        <Card>
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
              />
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
                                borderRadius: 3,
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
                value={sound}
                media={media}
                disabled={planning}
                onChange={(s) => {
                  setSound(s)
                  setSoundTouched(true)
                }}
              />
              <VoiceoverControl value={voice} onChange={setVoice} disabled={planning} planning={canPlan} />
              <TextInput
                label="Title"
                description="Optional. The agent names it otherwise."
                maxLength={120}
                value={title}
                onChange={(e) => {
                  setTitle(e.currentTarget.value)
                }}
              />
              <Group>
                {/* Waits for the config: before it loads, a click would skip the choice and create at once. */}
                <Button
                  type="submit"
                  size="md"
                  disabled={!valid || config.isPending}
                  loading={create.isPending && !dialog}
                >
                  Create video
                </Button>
                <Text size="sm" c="var(--va-faint)">
                  You can revise it in plain words afterwards.
                </Text>
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
          <RecentMine />
        </div>
      </div>
      <Modal
        opened={dialog !== null}
        onClose={() => {
          setDialog(null)
        }}
        title={dialog === 'plan' ? 'Plan your video' : 'Create your video'}
        size={dialog === 'plan' ? 'xl' : 'lg'}
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
            sound={sound}
            voiceover={voice.enabled ? voiceInput(voice) : undefined}
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
