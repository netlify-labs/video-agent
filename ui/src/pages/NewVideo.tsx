import { Button, Card, Group, NumberInput, Paper, Stack, Switch, Text, TextInput, Textarea, Title, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { $api, errorMessage, newIdempotencyKey } from '../api/client'

const EXAMPLES = [
  'A 20-second launch video for our new webhooks feature: what it is, one example event, and an end card with "Available today".',
  'A vertical 15-second clip for sales: "Preview every pull request" in three quick beats, ending with "Book a demo".',
  'A one-minute docs tutorial: how to add an environment variable to a project and redeploy it, in three steps.',
]

const ASPECTS = [
  { value: '16:9', label: 'Landscape 16:9', w: 32, h: 18 },
  { value: '9:16', label: 'Vertical 9:16', w: 18, h: 32 },
  { value: '1:1', label: 'Square 1:1', w: 24, h: 24 },
  { value: '4:5', label: 'Portrait 4:5', w: 22, h: 27 },
] as const

function useCreate() {
  const navigate = useNavigate()
  const [key] = useState(newIdempotencyKey)
  const create = $api.useMutation('post', '/api/v1/videos', {
    onSuccess: (v) => void navigate(`/videos/${v.id}`),
    onError: (e) => notifications.show({ color: 'red', title: "Couldn't start the video", message: errorMessage(e) }),
  })
  return { create, key }
}

export function QuickCreate() {
  const [prompt, setPrompt] = useState('')
  const { create, key } = useCreate()
  return (
    <Paper withBorder p="xl" radius="lg">
      <Stack>
        <Title order={3}>Make your first video</Title>
        <Textarea autosize minRows={3} placeholder="Describe the video you want…" value={prompt} onChange={(e) => { setPrompt(e.currentTarget.value) }} />
        <Group>
          <Button disabled={prompt.trim().length < 10} loading={create.isPending} onClick={() => { create.mutate({ body: { prompt }, params: { header: { 'idempotency-key': key } } }) }}>
            Create
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          Or start from an example:
        </Text>
        {EXAMPLES.map((e) => (
          <UnstyledButton key={e} onClick={() => { setPrompt(e) }}>
            <Text size="sm" c="dimmed" td="underline">
              {e}
            </Text>
          </UnstyledButton>
        ))}
      </Stack>
    </Paper>
  )
}

export function NewVideoPage() {
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]['value']>('16:9')
  const [auto, setAuto] = useState(true)
  const [seconds, setSeconds] = useState<number | string>(30)
  const [title, setTitle] = useState('')
  const { create, key } = useCreate()
  const valid = prompt.trim().length >= 10 && prompt.length <= 4000 && (auto || Number(seconds) > 0)

  return (
    <Stack maw={760}>
      <Title order={2}>New video</Title>
      <Textarea
        label="What should the video show?"
        description="Say who it's for, the key message, any exact text to show, and how it should end. Your company's brand and product context are applied automatically."
        autosize
        minRows={5}
        maxLength={4000}
        value={prompt}
        onChange={(e) => { setPrompt(e.currentTarget.value) }}
        rightSection={<Text size="xs" c="dimmed">{prompt.length}/4000</Text>}
        rightSectionWidth={80}
        styles={{ section: { alignItems: 'flex-end', paddingBottom: 6 } }}
      />
      <div>
        <Text size="sm" fw={500} mb={6}>
          Shape
        </Text>
        <Group gap="sm">
          {ASPECTS.map((a) => (
            <Card key={a.value} withBorder padding="sm" radius="md" component="button" type="button" onClick={() => { setAspect(a.value) }} style={{ cursor: 'pointer', borderColor: aspect === a.value ? 'var(--mantine-primary-color-filled)' : undefined, borderWidth: aspect === a.value ? 2 : 1 }} aria-pressed={aspect === a.value}>
              <Stack align="center" gap={6}>
                <div style={{ width: a.w * 1.6, height: a.h * 1.6, border: '2px solid currentColor', borderRadius: 4, opacity: 0.8 }} />
                <Text size="xs">{a.label}</Text>
              </Stack>
            </Card>
          ))}
        </Group>
      </div>
      <Group align="end">
        <Switch label="Auto length" description="The agent picks a sensible length" checked={auto} onChange={(e) => { setAuto(e.currentTarget.checked) }} />
        {!auto ? <NumberInput label="Target length (seconds)" min={3} value={seconds} onChange={setSeconds} w={200} /> : null}
      </Group>
      <TextInput label="Title (optional)" maxLength={120} value={title} onChange={(e) => { setTitle(e.currentTarget.value) }} />
      <Group>
        <Button
          size="md"
          disabled={!valid}
          loading={create.isPending}
          onClick={() => {
            create.mutate({
              body: { prompt, aspect, ...(auto ? {} : { durationSec: Number(seconds) }), ...(title.trim() ? { title: title.trim() } : {}) },
              params: { header: { 'idempotency-key': key } },
            })
          }}
        >
          Create video
        </Button>
      </Group>
    </Stack>
  )
}
