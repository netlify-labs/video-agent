// Render picture first (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1, §5.3): while the draft has timing
// changes the base version's MP4 doesn't show, recording waits, and this takes Record's place. One click renders the
// draft's other edits, without its narration (excludeNarration), as a normal new version; its progress shows here
// as on the Video page; when it's ready the narration moves onto that version (rebase-narration) and the editor
// reopens there, ready to record. The recorder (app/web/src/recorder) shows it in place of Record while timingPending.
import { Alert, Anchor, Button, Group, Progress, Stack, Text } from '@mantine/core'
import { IconMovie } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { $api, errorMessage, fetchClient, newIdempotencyKey } from '../api/client'
import { inProgress } from './bits'
import { KEEP_VISUALS_CREDITS } from './NarrationRenderDialog'

export interface RenderPictureFirstProps {
  videoId: string
  editId: string
  /** The draft has unsaved changes or no lock: the render waits (the button explains in `reason`). */
  disabled?: boolean
  reason?: string | undefined
  /** The render was queued as v`n`: the page stops saving the draft (it's rendered now). */
  onStarted?: (n: number) => void
  /** v`n` is ready and the narration is on its draft: open the editor there. */
  onReopen: (n: number) => void
}

type Phase =
  | { at: 'idle' }
  | { at: 'starting' }
  | { at: 'rendering'; n: number }
  | { at: 'moving'; n: number }
  | { at: 'failed'; n: number | null; message: string }

const STAGE_WORDS: Record<string, string> = {
  queued: 'Waiting for a free slot',
  starting: 'Starting the render',
  running: 'Rendering the new picture',
  finishing: 'Verifying and saving the files',
}

export function RenderPictureFirst(props: RenderPictureFirstProps) {
  const { videoId, editId } = props
  const [phase, setPhase] = useState<Phase>({ at: 'idle' })
  const [key] = useState(newIdempotencyKey)
  const n = phase.at === 'rendering' || phase.at === 'moving' ? phase.n : null
  // The same polling as the Video page: the video every 3 s for the version's status, /progress for Rendering N%.
  const video = $api.useQuery(
    'get',
    '/api/v1/videos/{id}',
    { params: { path: { id: videoId } } },
    { enabled: phase.at === 'rendering', refetchInterval: 3000, refetchIntervalInBackground: false },
  )
  const v = n === null ? undefined : video.data?.versions.find((x) => x.n === n)
  const progress = $api.useQuery(
    'get',
    '/api/v1/videos/{id}/progress',
    { params: { path: { id: videoId } } },
    {
      enabled: phase.at === 'rendering' && !!v && inProgress(v.status),
      refetchInterval: 3000,
      refetchIntervalInBackground: false,
    },
  )
  const reopen = useRef(props.onReopen)
  reopen.current = props.onReopen

  // Once the version is ready, move the narration onto it and reopen there; once it has stopped, say why.
  const status = v?.status
  useEffect(() => {
    if (phase.at !== 'rendering' || !status || inProgress(status)) return
    const at = phase.n
    if (status !== 'ready') {
      setPhase({
        at: 'failed',
        n: at,
        message: `v${at} didn't finish${v.error ? `: ${v.error.message}` : '.'} Your narration is still in this draft.`,
      })
      return
    }
    setPhase({ at: 'moving', n: at })
    void (async () => {
      const { data, error } = await fetchClient.POST('/api/v1/edits/{id}/rebase-narration', {
        params: { path: { id: editId } },
        body: { toN: at },
      })
      if (data) reopen.current(at)
      else setPhase({ at: 'failed', n: at, message: errorMessage(error) })
    })()
  }, [phase, status, v, editId])

  const start = async () => {
    setPhase({ at: 'starting' })
    const { data, error } = await fetchClient.POST('/api/v1/edits/{id}/render', {
      params: { path: { id: editId }, header: { 'idempotency-key': key } },
      body: { mode: 'keep_visuals', excludeNarration: true },
    })
    if (!data) {
      setPhase({ at: 'failed', n: null, message: errorMessage(error) })
      return
    }
    setPhase({ at: 'rendering', n: data.latestVersion })
    props.onStarted?.(data.latestVersion)
  }

  if (phase.at === 'idle' || phase.at === 'starting' || (phase.at === 'failed' && phase.n === null))
    return (
      <Stack gap={6} data-testid="render-picture-first">
        <Text size="sm">
          Your timing changes aren&apos;t in the picture yet, so recording would be out of sync. Render them
          first; your narration comes along to the new version.
        </Text>
        <Group gap="sm">
          <Button
            leftSection={<IconMovie size={16} />}
            loading={phase.at === 'starting'}
            disabled={props.disabled === true}
            onClick={() => void start()}
          >
            Render picture first (about {KEEP_VISUALS_CREDITS} credits)
          </Button>
          {props.disabled && props.reason ? (
            <Text size="xs" c="var(--va-faint)">
              {props.reason}
            </Text>
          ) : null}
        </Group>
        {phase.at === 'failed' ? (
          <Text size="sm" c="red" role="alert">
            {phase.message}
          </Text>
        ) : null}
      </Stack>
    )
  if (phase.at === 'failed')
    return (
      <Alert color="red" variant="light" role="alert" data-testid="render-picture-first">
        <Text size="sm">{phase.message}</Text>
        <Anchor component={Link} to={`/videos/${videoId}`} size="sm">
          See v{phase.n}
        </Anchor>
      </Alert>
    )
  const cp = progress.data?.versionN === phase.n ? progress.data.checkpoint : null
  const percent = v?.status === 'running' && cp?.renderPercent != null ? cp.renderPercent : null
  const words =
    phase.at === 'moving'
      ? 'Moving your narration onto the new version'
      : percent !== null
        ? `Rendering ${percent}%`
        : (STAGE_WORDS[v?.stage ?? v?.status ?? 'queued'] ?? 'Rendering the new picture')
  return (
    <Stack gap={6} data-testid="render-picture-first" aria-live="polite">
      <Text size="sm" fw={500}>
        Rendering the picture as v{phase.n}
      </Text>
      <Progress
        size="sm"
        value={phase.at === 'moving' ? 100 : (percent ?? 100)}
        animated={phase.at !== 'moving'}
        striped={percent === null}
        aria-label={words}
      />
      <Text size="xs" c="var(--va-muted)" className="num" data-testid="render-picture-first-stage">
        {words}. Usually a few minutes; the editor reopens on v{phase.n} when it&apos;s ready.
      </Text>
    </Stack>
  )
}
