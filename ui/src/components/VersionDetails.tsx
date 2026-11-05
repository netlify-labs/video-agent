// How a version was made: the Details card on the video page (the request, a few facts, an info button) and the
// full modal behind it (everything the run was given: the prompt, the feedback, the settings, the script, the media,
// the plan, and how the run went). Esc or the close button closes it.
import {
  ActionIcon,
  Anchor,
  Button,
  Card,
  CopyButton,
  Group,
  Modal,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core'
import { IconCheck, IconCopy, IconExternalLink, IconInfoCircle, IconMapPin } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { $api, type Version, type Video } from '../api/client'
import { clockTime, credits, duration } from './bits'
import { languageName } from './LanguageSelect'
import { voiceLabel } from './VoiceoverControl'

/** What a version sounds like, so a silent one isn't mistaken for missing audio. */
export function soundWords(v: Version): string {
  const parts = [
    v.links.narrationAudio ? 'your recorded voice-over' : v.voiceover ? 'AI voice-over' : null,
    v.sound === 'music' ? 'music' : v.sound === 'music_sfx' ? 'music and sound effects' : null,
  ].filter(Boolean)
  if (!parts.length) return 'Silent (no audio track)'
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The music the server picked before the run. */
function musicWords(m: NonNullable<Version['music']>): string {
  if (m.status === 'picked')
    return `${m.title ?? 'A track'} (${m.source === 'library' ? 'from your library' : 'picked from Openverse'})`
  if (m.status === 'skipped') return 'None found in time; the agent looked itself'
  return m.title ? `Adding ${m.title}…` : 'Finding music…'
}

const took = (v: Version) =>
  v.timings?.endedAt && v.timings.startedAt
    ? duration((new Date(v.timings.endedAt).getTime() - new Date(v.timings.startedAt).getTime()) / 1000)
    : null

const lengthWords = (v: Version) =>
  [
    v.output ? duration(v.output.durationSec) : null,
    v.targetDurationSec ? `asked ${v.targetDurationSec} s` : 'auto',
  ]
    .filter(Boolean)
    .join(' · ')

/** Where the version came from, in a line. */
function origin(video: Video, v: Version): string {
  if (v.mode === 'render_unchanged' && v.editedFromN) return `Edited in the browser from v${v.editedFromN}`
  if (v.editedFromN) return `Edited in the browser from v${v.editedFromN}, fitted to its narration`
  if (v.feedback.length) return `Feedback on v${v.parentN} incorporated`
  if (v.parentN) return `Revised from v${v.parentN}`
  if (video.remixOf && v.n === 1) return `Remix of ${video.remixOf.title} v${video.remixOf.n}`
  return 'The first version'
}

/** A fact: a small label over its value, left-aligned. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="va-fact">
      <Text size="xs" c="var(--va-faint)">
        {label}
      </Text>
      <Text size="sm" className="num" style={{ overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </div>
  )
}

/** A titled part of the modal. */
function Part({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="va-details-part">
      <Group justify="space-between" mb={8} gap="xs">
        <Text fw={600} size="sm">
          {title}
        </Text>
        {aside}
      </Group>
      {children}
    </section>
  )
}

const listOf = (items: string[]) => (
  <ul className="va-details-list">
    {items.map((x, i) => (
      <li key={i}>
        <Text size="sm">{x}</Text>
      </li>
    ))}
  </ul>
)

export function VersionDetailsModal({
  video,
  v,
  opened,
  onClose,
}: {
  video: Video
  v: Version | null
  opened: boolean
  onClose: () => void
}) {
  const media = $api.useQuery(
    'get',
    '/api/v1/videos/{id}/versions/{n}/media',
    { params: { path: { id: video.id, n: v?.n ?? 1 } } },
    { enabled: opened && v !== null, staleTime: 60_000 },
  )
  return (
    <Modal opened={opened && v !== null} onClose={onClose} size="xl" title={v ? `How v${v.n} was made` : ''}>
      {v ? <Everything video={video} v={v} media={media.data?.items ?? null} /> : null}
    </Modal>
  )
}

function Everything({
  video,
  v,
  media,
}: {
  video: Video
  v: Version
  media: { id: string; title?: string | null; filename: string; kind: string }[] | null
}) {
  const brief = v.plan?.brief
  return (
    <Stack gap="lg" data-testid="version-details">
      <Group gap={6} wrap="wrap">
        <Text size="sm" c="var(--va-muted)">
          {origin(video, v)} · {new Date(v.createdAt).toLocaleString()}
        </Text>
        {/* The agent run that made it, up top so it's seen without scrolling. */}
        {v.links.netlifyRun ? (
          <Anchor href={v.links.netlifyRun} target="_blank" size="sm" data-testid="agent-run-link">
            <Group gap={4} wrap="nowrap">
              View the agent run <IconExternalLink size={14} />
            </Group>
          </Anchor>
        ) : null}
      </Group>

      <Part
        title="Prompt"
        aside={
          <CopyButton value={v.prompt}>
            {({ copied, copy }) => (
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
        }
      >
        <Text size="sm" className="va-details-prompt">
          {v.prompt}
        </Text>
      </Part>

      {v.feedback.length ? (
        <Part title={`Feedback it was asked to incorporate (${v.feedback.length})`}>
          <Stack gap={6}>
            {v.feedback.map((c, i) => (
              <div key={i} className="va-details-note">
                <Text size="xs" c="var(--va-faint)">
                  {c.author ?? 'Someone'}
                  {c.timeSec !== null ? (
                    <>
                      {' · '}
                      {c.spot ? <IconMapPin size={11} style={{ verticalAlign: -1 }} /> : null}
                      {clockTime(c.timeSec)}
                    </>
                  ) : null}
                </Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {c.body}
                </Text>
              </div>
            ))}
          </Stack>
        </Part>
      ) : null}

      <Part title="Settings">
        <div className="va-facts">
          <Fact label="Length">{lengthWords(v)}</Fact>
          <Fact label="Shape">
            {video.aspect} · {video.dimensions.width}×{video.dimensions.height}
          </Fact>
          <Fact label="Language">{languageName(video.language)}</Fact>
          <Fact label="Sound">{soundWords(v)}</Fact>
          {v.music ? <Fact label="Music">{musicWords(v.music)}</Fact> : null}
          {v.music?.query ? <Fact label="Music search">{v.music.query}</Fact> : null}
          {v.voiceover ? (
            <>
              <Fact label="Voice">{voiceLabel(v.voiceover.voice)}</Fact>
              <Fact label="Pace">
                {v.voiceover.speed === null || v.voiceover.speed === 1
                  ? 'Normal'
                  : v.voiceover.speed < 1
                    ? `Slower (${v.voiceover.speed}×)`
                    : `Faster (${v.voiceover.speed}×)`}
              </Fact>
            </>
          ) : null}
        </div>
      </Part>

      {v.voiceover?.script?.length ? (
        <Part title="Script">
          <ol className="va-details-list">
            {v.voiceover.script.map((line, i) => (
              <li key={i}>
                <Text size="sm">{line}</Text>
              </li>
            ))}
          </ol>
        </Part>
      ) : null}

      {media === null || media.length ? (
        <Part title="Media">
          {media === null ? (
            <Text size="sm" c="var(--va-faint)">
              Loading…
            </Text>
          ) : (
            listOf(media.map((m) => `${m.title ?? m.filename} (${m.kind})`))
          )}
        </Part>
      ) : null}

      {brief ? (
        <Part title="The plan">
          <Stack gap="sm">
            <div className="va-facts">
              <Fact label="Goal">{brief.goal}</Fact>
              <Fact label="Audience">{brief.audience}</Fact>
              <Fact label="Key message">{brief.keyMessage}</Fact>
              <Fact label="Tone">{brief.tone}</Fact>
              <Fact label="Call to action">{brief.callToAction}</Fact>
            </div>
            {brief.beats.length ? (
              <div>
                <Text size="xs" c="var(--va-faint)" mb={4}>
                  Beats
                </Text>
                <ol className="va-details-list">
                  {brief.beats.map((b, i) => (
                    <li key={i}>
                      <Text size="sm">
                        <span className="num" style={{ color: 'var(--va-faint)' }}>
                          {b.seconds} s ·{' '}
                        </span>
                        {b.text}
                      </Text>
                      {b.narration ? (
                        <Text size="sm" c="var(--va-muted)" fs="italic">
                          “{b.narration}”
                        </Text>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {brief.mustInclude.length ? (
              <div>
                <Text size="xs" c="var(--va-faint)" mb={4}>
                  Must include
                </Text>
                {listOf(brief.mustInclude)}
              </div>
            ) : null}
            {brief.avoid.length ? (
              <div>
                <Text size="xs" c="var(--va-faint)" mb={4}>
                  Avoid
                </Text>
                {listOf(brief.avoid)}
              </div>
            ) : null}
            {v.plan?.answers.length ? (
              <div>
                <Text size="xs" c="var(--va-faint)" mb={4}>
                  Answers to the planner
                </Text>
                <Stack gap={6}>
                  {v.plan.answers.map((a, i) => (
                    <div key={i}>
                      <Text size="sm" c="var(--va-muted)">
                        {a.question}
                      </Text>
                      <Text size="sm">{Array.isArray(a.answer) ? a.answer.join(', ') : a.answer}</Text>
                    </div>
                  ))}
                </Stack>
              </div>
            ) : null}
          </Stack>
        </Part>
      ) : null}

      <Part title="The run">
        <div className="va-facts">
          <Fact label="Agent">{v.agent?.agent ?? '—'}</Fact>
          {v.agent?.model ? <Fact label="Model">{v.agent.model}</Fact> : null}
          {v.agent?.effort ? <Fact label="Effort">{v.agent.effort}</Fact> : null}
          <Fact label="Credits">{credits(v.usage?.totalCreditsCost)}</Fact>
          <Fact label="Attempts">{v.attempts}</Fact>
          {took(v) ? <Fact label="Took">{took(v)}</Fact> : null}
          {v.output ? <Fact label="File">{(v.output.bytes / 1e6).toFixed(2)} MB</Fact> : null}
          {v.agent ? <Fact label="Prompt template">v{v.agent.promptTemplateVersion}</Fact> : null}
        </div>
        {v.output?.notices.length ? (
          <Stack gap={2} mt="sm">
            {v.output.notices.map((n) => (
              <Text key={n} size="sm" c="var(--va-warning-ink)">
                {n}
              </Text>
            ))}
          </Stack>
        ) : null}
        {v.error ? (
          <Text size="sm" c="var(--va-negative)" mt="sm">
            {v.error.message}
          </Text>
        ) : null}
      </Part>
    </Stack>
  )
}

/** The button that opens a version's full details. */
export function DetailsButton({
  v,
  onOpen,
  size = 'md',
}: {
  v: Version
  onOpen: () => void
  size?: 'sm' | 'md'
}) {
  return (
    <Tooltip label={`How v${v.n} was made`}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={size}
        aria-label={`How v${v.n} was made`}
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        <IconInfoCircle size={size === 'sm' ? 15 : 18} />
      </ActionIcon>
    </Tooltip>
  )
}

/** The Details card in the video page's rail: the request, a few facts, and the way into the rest. */
export function DetailsCard({ video, v, onOpen }: { video: Video; v: Version; onOpen: () => void }) {
  return (
    <Card data-testid="details-card">
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <Text fw={600}>Details for v{v.n}</Text>
        <DetailsButton v={v} onOpen={onOpen} />
      </Group>
      <Text size="xs" c="var(--va-faint)" mb={2}>
        {v.feedback.length ? `Prompt · ${origin(video, v)}` : 'Prompt'}
      </Text>
      <Text size="sm" lineClamp={4} mb={6} style={{ whiteSpace: 'pre-wrap' }}>
        {v.prompt}
      </Text>
      <Anchor component="button" type="button" size="sm" onClick={onOpen} mb="md" display="block" ta="left">
        Everything it was made with
      </Anchor>
      <div className="va-facts">
        <Fact label="Length">{lengthWords(v)}</Fact>
        <Fact label="Sound">{soundWords(v)}</Fact>
        {v.music ? <Fact label="Music">{musicWords(v.music)}</Fact> : null}
        <Fact label="Credits">{credits(v.usage?.totalCreditsCost)}</Fact>
        <Fact label="Took">{took(v) ?? '—'}</Fact>
      </div>
      {v.links.netlifyRun ? (
        <Anchor
          href={v.links.netlifyRun}
          target="_blank"
          size="sm"
          c="var(--va-muted)"
          mt="md"
          display="block"
        >
          <Group gap={4}>
            View the run in Netlify <IconExternalLink size={14} />
          </Group>
        </Anchor>
      ) : null}
    </Card>
  )
}
