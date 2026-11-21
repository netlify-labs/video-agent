// Remix a video (docs/plans/2026-11-03-remix.md §3.7): one dialog for every entry point (video page, Library tile menu,
// New video's "Start from an existing video", the share page's link). A remix is a NEW video that starts from the
// source version's finished composition: the box says what to change; shape, length, language, sound, AI voice-over
// and media start as the source's and can be changed. The source's recorded narration never carries over.
import {
  Alert,
  Button,
  Collapse,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from '@mantine/core'
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks'
import { IconChevronDown, IconChevronRight, IconPlayerPlay, IconSearch } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { $api, newIdempotencyKey, useCanCreate, type Version, type Video } from '../api/client'
import { VersionImage, fileUrl, imageUrl, showError } from './bits'
import { LanguageSelect } from './LanguageSelect'
import { MediaChips, type Media } from './MediaPicker'
import { PlanPanel } from './PlanPanel'
import { LookControl } from './LookPicker'
import { SoundControl, soundAfterPick, type Sound } from './SoundControl'
import { VoiceoverControl, sameVoice, voiceInput, voiceStateFrom, type VoiceState } from './VoiceoverControl'

type Aspect = Video['aspect']
type Language = Video['language']

const ASPECTS: { value: Aspect; label: string }[] = [
  { value: '16:9', label: '16:9 wide' },
  { value: '9:16', label: '9:16 vertical' },
  { value: '1:1', label: '1:1 square' },
  { value: '4:5', label: '4:5 portrait' },
]

/** Remixing is on for this deployment (an admin setting); while the config loads it reads as off. */
export function useRemixEnabled(): boolean {
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  return config.data?.remixEnabled === true
}

/** Whether this person may remix here: they can create videos and remixing is on. */
export function useCanRemix(): boolean {
  const canCreate = useCanCreate()
  const enabled = useRemixEnabled()
  return canCreate && enabled
}

/** The latest ready version of a video, which every entry point but the video page remixes. */
export function latestReady(video: Video): Version | undefined {
  return [...video.versions].sort((a, b) => b.n - a.n).find((v) => v.status === 'ready')
}

export interface RemixFormProps {
  video: Video
  version: Version
  /** Called after the remix is made (the dialog closes; New video navigates the same way). */
  onDone?: () => void
  onCancel?: () => void
  /** Extra controls above the buttons (New video's "Start from scratch"). */
  footer?: ReactNode
}

/** The remix form, on its own so New video can show it in place. */
export function RemixForm({ video, version, onDone, onCancel, footer }: RemixFormProps) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  const canPlan = config.data?.planningAvailable === true
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState<Aspect>(video.aspect)
  const [language, setLanguage] = useState<Language>(video.language)
  const sourceSeconds =
    version.targetDurationSec ?? (version.output ? Math.round(version.output.durationSec) : null)
  const [seconds, setSeconds] = useState<number | string>(sourceSeconds ?? '')
  const [sound, setSound] = useState<Sound | null>(null)
  const [voice, setVoice] = useState<VoiceState | null>(null)
  // Undefined: the source version's look (the server inherits it); sent only when changed, null for None.
  const [look, setLook] = useState<string | null | undefined>(undefined)
  const [media, setMedia] = useState<Media[] | null>(null)
  const [planning, setPlanning] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [key] = useState(newIdempotencyKey)
  const sourceMedia = $api.useQuery('get', '/api/v1/videos/{id}/versions/{n}/media', {
    params: { path: { id: video.id, n: version.n } },
  })
  // The source's media start as chips; the remix's list is whatever is left (plus additions).
  useEffect(() => {
    if (media === null && sourceMedia.data) setMedia(sourceMedia.data.items)
  }, [media, sourceMedia.data])
  const chips = media ?? []
  const effSound = sound ?? version.sound
  const sourceVoice = voiceStateFrom(version.voiceover)
  const effVoice = voice ?? sourceVoice
  const voiceChanged = voice !== null && !sameVoice(voice, sourceVoice)
  const narrated = Boolean(version.links.narrationAudio)
  const history = video.versions
    .filter((v) => v.n <= version.n)
    .sort((a, b) => a.n - b.n)
    .map((v) => v.prompt)
  const mediaChanged =
    media !== null &&
    sourceMedia.data !== undefined &&
    media.map((m) => m.id).join() !== sourceMedia.data.items.map((m) => m.id).join()
  const durationSec = typeof seconds === 'number' && seconds > 0 ? seconds : undefined
  const body = (planId?: string | null) => ({
    prompt: prompt.trim(),
    fromVersion: version.n,
    ...(aspect !== video.aspect ? { aspect } : {}),
    ...(language !== video.language ? { language } : {}),
    ...(durationSec && durationSec !== sourceSeconds ? { durationSec } : {}),
    ...(sound ? { sound } : {}),
    ...(voiceChanged && (!planId || !effVoice.enabled) ? { voiceover: voiceInput(effVoice) } : {}),
    ...(mediaChanged ? { mediaIds: chips.map((m) => m.id) } : {}),
    ...(look !== undefined ? { look } : {}),
    ...(planId ? { planId } : {}),
  })
  const remix = $api.useMutation('post', '/api/v1/videos/{id}/remix', {
    onSuccess: (made) => {
      void qc.invalidateQueries()
      onDone?.()
      void navigate(`/videos/${made.id}`)
    },
    onError: showError,
  })
  const make = (planId?: string | null) => {
    remix.mutate({
      params: { path: { id: video.id }, header: { 'idempotency-key': key } },
      body: body(planId),
    })
  }
  const ready = prompt.trim().length >= 3

  if (planning)
    return (
      <PlanPanel
        prompt={prompt.trim()}
        aspect={aspect !== video.aspect ? aspect : undefined}
        durationSec={durationSec}
        remixOf={{ videoId: video.id, version: version.n }}
        mediaIds={chips.map((m) => m.id)}
        sound={effSound}
        voiceover={effVoice.enabled ? voiceInput(effVoice) : undefined}
        creating={remix.isPending}
        onClose={() => {
          setPlanning(false)
        }}
        onCreate={(planId) => {
          make(planId)
        }}
      />
    )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) make()
      }}
    >
      <Stack gap="sm" data-testid="remix-form">
        <div>
          <UnstyledButton
            onClick={() => {
              setShowSource((s) => !s)
            }}
            aria-expanded={showSource}
          >
            <Group gap={4}>
              {showSource ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              <Text size="sm" c="var(--va-muted)">
                What this video was made from
              </Text>
            </Group>
          </UnstyledButton>
          <Collapse expanded={showSource}>
            <Stack gap={6} mt={6} className="va-remix-source">
              {history.map((p, i) => (
                <Text key={i} size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  <Text span c="var(--va-faint)" className="num">
                    v{i + 1}{' '}
                  </Text>
                  {p}
                </Text>
              ))}
              {version.output?.summary ? (
                <Text size="sm" c="var(--va-muted)" style={{ whiteSpace: 'pre-wrap' }}>
                  {version.output.summary}
                </Text>
              ) : null}
            </Stack>
          </Collapse>
        </div>
        <Textarea
          label="What would you change?"
          description="Be as descriptive as possible: a new topic, swapped names, a different length…"
          autosize
          minRows={3}
          maxLength={4000}
          data-autofocus
          value={prompt}
          onChange={(e) => {
            setPrompt(e.currentTarget.value)
          }}
        />
        <Group grow align="flex-start">
          <Select
            label="Shape"
            data={ASPECTS}
            value={aspect}
            allowDeselect={false}
            onChange={(v) => {
              if (v) setAspect(v)
            }}
          />
          <NumberInput
            label="Length (seconds)"
            min={3}
            max={600}
            value={seconds}
            placeholder="Auto"
            onChange={setSeconds}
          />
        </Group>
        {aspect !== video.aspect ? (
          <Text size="sm" c="var(--va-warning-ink)">
            A new shape: the agent will re-lay out every scene.
          </Text>
        ) : null}
        <LanguageSelect defaultValue={video.language} onChange={setLanguage} />
        <MediaChips
          value={chips}
          onChange={(next) => {
            const s = soundAfterPick(effSound, sound !== null, chips, next)
            if (s !== effSound) setSound(s)
            setMedia(next)
          }}
          label="Add media"
        />
        <SoundControl
          value={effSound}
          media={chips}
          onChange={(s) => {
            setSound(s === version.sound ? null : s)
          }}
        />
        <VoiceoverControl value={effVoice} planning={canPlan} onChange={setVoice} />
        <LookControl
          value={look}
          inherit={version.look}
          onChange={(id) => {
            setLook(id === (version.look?.id ?? null) ? undefined : id)
          }}
        />
        {narrated ? (
          <Alert variant="light" color="gray" p="xs">
            <Text size="sm">Your recorded narration isn’t carried over.</Text>
          </Alert>
        ) : null}
        {footer}
        <Group justify="flex-end" gap="xs">
          {onCancel ? (
            <Button variant="subtle" color="gray" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {canPlan ? (
            <Button
              variant="default"
              disabled={!ready}
              onClick={() => {
                setPlanning(true)
              }}
            >
              Plan it first
            </Button>
          ) : null}
          <Button type="submit" disabled={!ready} loading={remix.isPending}>
            Remix
          </Button>
        </Group>
      </Stack>
    </form>
  )
}

/** The Remix dialog: full screen on a phone. */
export function RemixDialog(props: { video: Video; version: Version; opened: boolean; onClose: () => void }) {
  const phone = useMediaQuery('(max-width: 600px)')
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title={`Remix ${props.video.title} v${props.version.n}`}
      size="lg"
      fullScreen={phone}
    >
      {props.opened ? (
        <RemixForm
          video={props.video}
          version={props.version}
          onDone={props.onClose}
          onCancel={props.onClose}
        />
      ) : null}
    </Modal>
  )
}

/**
 * New video's "Start from an existing video" (remix spec §3.7): search the Library (Everyone, Mine or Favorites) for a
 * ready video, then pick the version to start from (the latest ready one by default).
 */
export function RemixSourcePicker(props: {
  opened: boolean
  onClose: () => void
  onPick: (video: Video, version: Version) => void
}) {
  const phone = useMediaQuery('(max-width: 600px)')
  const [q, setQ] = useState('')
  const [debounced] = useDebouncedValue(q, 250)
  const [scope, setScope] = useState<'all' | 'me' | 'favorites'>('all')
  const [chosen, setChosen] = useState<Video | null>(null)
  const [n, setN] = useState<string | null>(null)
  const list = $api.useQuery(
    'get',
    '/api/v1/videos',
    {
      params: {
        query: {
          status: 'ready',
          owner: scope === 'me' ? 'me' : 'all',
          ...(scope === 'favorites' ? { favorite: 'true' as const } : {}),
          ...(debounced ? { q: debounced } : {}),
          limit: 24,
        },
      },
    },
    { enabled: props.opened },
  )
  const items = (list.data?.items ?? []).filter((v) => latestReady(v) !== undefined)
  const readyVersions = chosen
    ? [...chosen.versions].filter((v) => v.status === 'ready').sort((a, b) => b.n - a.n)
    : []
  const version = chosen ? (readyVersions.find((v) => String(v.n) === n) ?? readyVersions[0]) : undefined
  const owner = (v: Video) => v.owner.name ?? v.owner.email?.split('@')[0]
  const pickRow = (
    <Group justify="space-between" align="flex-end" wrap="nowrap">
      <Select
        label="Version"
        data={readyVersions.map((v) => ({ value: String(v.n), label: `v${v.n}` }))}
        value={version ? String(version.n) : null}
        allowDeselect={false}
        onChange={setN}
        w={140}
      />
      <Button
        onClick={() => {
          if (chosen && version) props.onPick(chosen, version)
        }}
      >
        Remix this
      </Button>
    </Group>
  )
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title="Start from an existing video"
      size={1320}
      fullScreen={phone}
    >
      <div className="va-remix-picker">
        <Stack gap="sm" style={{ minWidth: 0 }}>
          <TextInput
            aria-label="Search videos"
            placeholder="Search prompts and titles"
            leftSection={<IconSearch size={16} />}
            value={q}
            data-autofocus
            onChange={(e) => {
              setQ(e.currentTarget.value)
            }}
          />
          <SegmentedControl
            value={scope}
            onChange={(v) => {
              setScope(v)
            }}
            data={[
              { label: 'Everyone', value: 'all' },
              { label: 'Mine', value: 'me' },
              { label: 'Favorites', value: 'favorites' },
            ]}
          />
          <Stack gap={4} className="va-remix-list" role="listbox" aria-label="Videos">
            {list.isLoading ? (
              <Text size="sm" c="var(--va-muted)">
                Loading…
              </Text>
            ) : items.length === 0 ? (
              <Text size="sm" c="var(--va-muted)">
                {scope === 'favorites' && !debounced
                  ? 'No favorites yet. Star a video in the Library to find it here.'
                  : 'No ready videos match.'}
              </Text>
            ) : (
              items.map((v) => {
                const ready = latestReady(v)
                return (
                  <UnstyledButton
                    key={v.id}
                    role="option"
                    aria-selected={chosen?.id === v.id}
                    className="va-remix-pick"
                    data-selected={chosen?.id === v.id ? 'true' : undefined}
                    onClick={() => {
                      setChosen(v)
                      setN(null)
                    }}
                  >
                    <span className="va-remix-thumb" data-testid={`remix-thumb-${v.id}`}>
                      {ready ? <VersionImage videoId={v.id} v={ready} file="poster" sizes="96px" /> : null}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <Text size="sm" fw={500} lineClamp={1}>
                        {v.title}
                      </Text>
                      <Text size="xs" c="var(--va-muted)" lineClamp={1}>
                        {[owner(v), v.aspect].filter(Boolean).join(' · ')}
                      </Text>
                      <Text size="xs" c="var(--va-faint)" lineClamp={1}>
                        {ready?.prompt}
                      </Text>
                    </span>
                  </UnstyledButton>
                )
              })
            )}
          </Stack>
        </Stack>
        <div className="va-remix-preview" data-testid="remix-preview">
          {chosen && version ? (
            <Stack gap="sm">
              {/* Keyed, so choosing another video or version loads that one. */}
              <video
                key={`${chosen.id}-${version.n}`}
                className="va-remix-video"
                data-aspect={chosen.aspect}
                src={fileUrl(chosen.id, version.n, 'video')}
                poster={imageUrl(chosen.id, version, 'poster')}
                controls
                playsInline
                preload="metadata"
                aria-label={`${chosen.title}, version ${version.n}`}
              />
              <div>
                <Text fw={600} lineClamp={2}>
                  {chosen.title}
                </Text>
                <Text size="xs" c="var(--va-muted)">
                  {[owner(chosen), chosen.aspect, `v${version.n}`].filter(Boolean).join(' · ')}
                </Text>
              </div>
              <Text size="sm" c="var(--va-muted)" lineClamp={5}>
                {version.prompt}
              </Text>
              {pickRow}
            </Stack>
          ) : (
            <div className="va-remix-empty">
              <IconPlayerPlay size={28} />
              <Text size="sm">Select a video to watch it here before you start from it.</Text>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** The non-secret hint the share page reads before asking who's viewing (remix spec §3.7); never used for auth. */
export const CREATOR_HINT_COOKIE = 'va_creator'

/**
 * Keeps the share page's hint cookie in step with this person: set while they can remix, cleared when they can't
 * (role changed, remixing turned off). The share page asks /api/v1/me only when it's there, so the public's views of
 * a share page never call the API. Mounted on every signed-in page; sign-out clears it in auth.tsx.
 */
export function CreatorHint() {
  const me = $api.useQuery('get', '/api/v1/me')
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  const known = me.data !== undefined && config.data !== undefined
  const can = (me.data?.role === 'admin' || me.data?.role === 'creator') && config.data?.remixEnabled === true
  useEffect(() => {
    if (!known) return
    setCreatorHint(can)
  }, [known, can])
  return null
}

export function setCreatorHint(on: boolean) {
  try {
    document.cookie = on
      ? `${CREATOR_HINT_COOKIE}=1; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`
      : `${CREATOR_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
  } catch {
    // Cookies can be blocked; the share page then just doesn't offer Remix.
  }
}
