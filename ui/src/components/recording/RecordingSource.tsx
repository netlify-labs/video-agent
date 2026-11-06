// Where a demo's recording comes from (screen-recording plan §4.3, §4.5; va-rsk5.4.1, va-rsk5.4.7): drop or choose a
// file (with its trace.json beside it, if there is one), pick one from the library (recordings with cursor data
// first), or record the screen here. A dropped file is converted in the browser when it isn't already in the
// recording format, then uploaded; the result goes to setup.
import { Alert, Badge, Button, Card, Code, Group, Progress, Stack, Text, UnstyledButton } from '@mantine/core'
import { IconPlayerRecordFilled, IconUpload } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import { $api } from '../../api/client'
import { useAuth } from '../../auth'
import { ConvertError, convertRecording, estimatedBytes, FFMPEG_COMMAND } from '../../lib/recording-convert'
import { readTrace, uploadRecording, type Trace } from '../../lib/recording-upload'
import { UploadError } from '../../lib/upload'
import { RecordScreen } from './RecordScreen'

const VIDEO = /\.(mp4|mov|webm|m4v)$/i
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
const seconds = (s: number | null) =>
  s === null ? '' : `${String(Math.floor(s / 60))}:${String(Math.round(s % 60)).padStart(2, '0')}`

type Stage =
  | { kind: 'idle' }
  | { kind: 'record' }
  | { kind: 'converting'; progress: number; estimate: number | null }
  | { kind: 'uploading'; sent: number; total: number; phase: string }
  | { kind: 'error'; message: string; ffmpeg?: boolean }

export function RecordingSource(props: { onReady: (mediaId: string) => void }) {
  const auth = useAuth()
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const library = $api.useQuery('get', '/api/v1/media', { params: { query: { kind: 'video', limit: 100 } } })
  const recordings = (library.data?.items ?? [])
    .filter((m) => m.role === 'screen-recording' && m.status === 'ready')
    .sort((a, b) => Number(b.hasTrace) - Number(a.hasTrace))

  const upload = async (file: File, trace: Trace | null) => {
    setStage({ kind: 'uploading', sent: 0, total: file.size, phase: 'hashing' })
    const id = await uploadRecording(file, {
      trace,
      ...(auth.user?.id ? { userId: auth.user.id } : {}),
      onProgress: (p) => {
        setStage({ kind: 'uploading', sent: p.sent, total: p.total, phase: p.phase })
      },
    })
    props.onReady(id)
  }

  const run = async (step: () => Promise<void>) => {
    try {
      await step()
    } catch (e) {
      if (e instanceof ConvertError && e.unsupported)
        setStage({
          kind: 'error',
          message: "This browser can't convert the recording. Convert it with ffmpeg, then upload the MP4:",
          ffmpeg: true,
        })
      else
        setStage({
          kind: 'error',
          message:
            e instanceof UploadError || e instanceof ConvertError
              ? e.message
              : "The recording couldn't be uploaded.",
        })
    }
  }

  const take = (files: File[]) => {
    const video = files.find((f) => VIDEO.test(f.name) || f.type.startsWith('video/'))
    const traceFile = files.find((f) => f.name.endsWith('.json'))
    if (!video) {
      setStage({ kind: 'error', message: 'Choose an MP4, MOV or WebM screen recording.' })
      return
    }
    void run(async () => {
      const trace = traceFile ? await readTrace(traceFile) : null
      setStage({ kind: 'converting', progress: 0, estimate: null })
      const file = await convertRecording(video, {
        onFacts: (f, reason) => {
          if (reason)
            setStage({
              kind: 'converting',
              progress: 0,
              estimate: estimatedBytes(f.width, f.height, f.duration),
            })
        },
        onProgress: (progress) => {
          setStage((s) => (s.kind === 'converting' ? { ...s, progress } : s))
        },
      })
      await upload(file, trace)
    })
  }

  if (stage.kind === 'record')
    return (
      <Card withBorder radius="lg" p="lg">
        <RecordScreen
          onRecorded={(file) => void run(() => upload(file, null))}
          onCancel={() => {
            setStage({ kind: 'idle' })
          }}
        />
      </Card>
    )
  if (stage.kind === 'converting' || stage.kind === 'uploading') {
    const pct =
      stage.kind === 'converting' ? stage.progress * 100 : (stage.sent / Math.max(1, stage.total)) * 100
    const label =
      stage.kind === 'converting'
        ? `Converting to the recording format${stage.estimate ? ` (about ${mb(stage.estimate)})` : ''}…`
        : stage.phase === 'hashing'
          ? 'Reading the file…'
          : stage.phase === 'checking'
            ? 'Checking the recording…'
            : `Uploading ${mb(stage.sent)} of ${mb(stage.total)}…`
    return (
      <Card withBorder radius="lg" p="lg" aria-busy="true">
        <Stack gap="xs">
          <Text size="sm" data-testid="recording-progress">
            {label}
          </Text>
          <Progress value={pct} aria-label={label} animated />
        </Stack>
      </Card>
    )
  }
  return (
    <Stack gap="md">
      {stage.kind === 'error' ? (
        <Alert color="red" role="alert" title="That didn't work">
          <Stack gap="xs">
            <Text size="sm">{stage.message}</Text>
            {stage.ffmpeg ? (
              <Code block style={{ whiteSpace: 'pre-wrap' }}>
                {FFMPEG_COMMAND}
              </Code>
            ) : null}
          </Stack>
        </Alert>
      ) : null}
      <Card
        withBorder
        radius="lg"
        p="xl"
        data-testid="recording-drop"
        style={{
          borderStyle: 'dashed',
          background: over ? 'var(--va-hover, rgba(0,0,0,0.03))' : undefined,
          textAlign: 'center',
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => {
          setOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          take([...e.dataTransfer.files])
        }}
      >
        <Stack align="center" gap="xs">
          <IconUpload size={28} />
          <Text fw={500}>Drop a screen recording here</Text>
          <Text size="sm" c="var(--va-muted)">
            MP4, MOV or WebM, up to 5 minutes. Add its trace.json from video-agent record for a smooth cursor.
          </Text>
          <Group>
            <Button variant="default" onClick={() => input.current?.click()}>
              Choose a file
            </Button>
            <Button
              variant="light"
              color="red"
              leftSection={<IconPlayerRecordFilled size={14} />}
              onClick={() => {
                setStage({ kind: 'record' })
              }}
            >
              Record your screen
            </Button>
          </Group>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            aria-label="Screen recording file"
            accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v,.json,application/json"
            onChange={(e) => {
              take([...(e.currentTarget.files ?? [])])
              e.currentTarget.value = ''
            }}
          />
        </Stack>
      </Card>
      {recordings.length ? (
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            Or use one from your library
          </Text>
          {recordings.map((m) => (
            <UnstyledButton
              key={m.id}
              onClick={() => {
                props.onReady(m.id)
              }}
              aria-label={`Use ${m.title ?? m.filename}`}
            >
              <Card withBorder radius="md" p="sm">
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap">
                    {m.urls?.poster ? (
                      <img
                        src={m.urls.poster}
                        alt=""
                        width={64}
                        height={36}
                        style={{ objectFit: 'cover', borderRadius: 4 }}
                      />
                    ) : null}
                    <div>
                      <Text size="sm" fw={500} lineClamp={1}>
                        {m.title ?? m.filename}
                      </Text>
                      <Text size="xs" c="var(--va-muted)" className="num">
                        {seconds(m.durationSec)}
                        {m.width && m.height ? ` · ${String(m.width)}×${String(m.height)}` : ''}
                      </Text>
                    </div>
                  </Group>
                  {m.hasTrace ? (
                    <Badge variant="light" size="sm">
                      Exact cursor
                    </Badge>
                  ) : null}
                </Group>
              </Card>
            </UnstyledButton>
          ))}
        </Stack>
      ) : null}
    </Stack>
  )
}
