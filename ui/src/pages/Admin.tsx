import { Alert, Anchor, Button, Card, Group, NumberInput, Select, Stack, Switch, Text } from '@mantine/core'
import { modals } from '@mantine/modals'
import { WebhookCard } from '../components/WebhookCard'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router'
import { $api } from '../api/client'
import { PageHeader, relativeTime, showError, useAfterWrite } from '../components/bits'

const STAGE: Record<string, string> = {
  finding_music: 'Finding music',
  starting: 'Starting',
  running: 'Making',
  cancelling: 'Stopping',
  finishing: 'Saving',
}
const FAILURE: Record<string, string> = {
  needs_input: 'Agent asked a question',
  credits_unavailable: 'No AI credits',
  artifacts_missing: 'Files missing or mismatched',
  invalid_output: 'Wrong size or broken file',
  source_unavailable: 'Revision source missing',
  start_failed: "Run didn't start",
  unresolved_start: 'Unresolved start',
  runner_failed: 'Agent run failed',
  queue_timeout: 'Waited too long in the queue',
}

export function AdminPage() {
  const qc = useQueryClient()
  const me = $api.useQuery('get', '/api/v1/me')
  const isAdmin = me.data?.role === 'admin'
  const stats = $api.useQuery('get', '/api/v1/stats', {}, { refetchInterval: 15_000, enabled: isAdmin })
  const users = $api.useQuery('get', '/api/v1/users', {}, { enabled: isAdmin })
  const done = () => void qc.invalidateQueries()
  const afterWrite = { onSuccess: done, onError: showError }
  const update = $api.useMutation('patch', '/api/v1/users/{id}', afterWrite)
  const resolve = $api.useMutation('post', '/api/v1/admin/attempts/{id}/resolve', afterWrite)
  const resume = $api.useMutation('post', '/api/v1/admin/queue/resume', afterWrite)
  const transfer = $api.useMutation('post', '/api/v1/transfers', {
    onSuccess: (r) => {
      notifications.show({ message: `Transferred ${r.transferred} video${r.transferred === 1 ? '' : 's'}.` })
      done()
    },
    onError: showError,
  })
  const openTransfer = (from: { id: string; email: string }) => {
    let to: string | null = null
    const targets = (users.data ?? [])
      .filter((x) => x.id !== from.id && !x.disabled && (x.role === 'admin' || x.role === 'creator'))
      .map((x) => ({ value: x.id, label: x.email }))
    modals.openConfirmModal({
      title: `Transfer ${from.email}'s videos`,
      children: (
        <Stack gap="xs">
          <Text size="sm" c="var(--va-muted)">
            The new owner gets publish, private and delete on all of them. Who made each version doesn't
            change.
          </Text>
          <Select
            label="Transfer to"
            data={targets}
            searchable
            data-autofocus
            onChange={(v) => {
              to = v
            }}
          />
        </Stack>
      ),
      labels: { confirm: 'Transfer', cancel: 'Cancel' },
      onConfirm: () => {
        if (to) transfer.mutate({ body: { toUserId: to, fromUserId: from.id } })
      },
    })
  }
  const cancel = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/cancel', afterWrite)

  if (me.data && !isAdmin) return <Navigate to="/" replace />
  const s = stats.data
  const failures = (s?.failuresThisWeek ?? []).reduce((n, f) => n + f.count, 0)
  const thisWeek = [...new Set((s?.usage ?? []).map((u) => u.week))].sort().at(-1)
  const weekRows = (s?.usage ?? []).filter((u) => u.week === thisWeek)
  const weekCredits = weekRows.reduce((sum, u) => sum + (u.credits ?? 0), 0)
  const weekUnknown = weekRows.some((u) => u.credits === null)
  const finding = !s
    ? 'Loading…'
    : s.queuePausedReason
      ? 'New runs are paused.'
      : s.unresolved.length
        ? `${s.unresolved.length} start${s.unresolved.length === 1 ? '' : 's'} need${s.unresolved.length === 1 ? 's' : ''} a decision.`
        : `${s.inFlight.length} of ${s.maxActiveRuns} run slots in use, ${s.queued} queued, ${failures} ${failures === 1 ? 'failure' : 'failures'} in the last 7 days.`

  return (
    <>
      <PageHeader title="Admin" sub={finding} />
      <Stack gap="md">
        {s?.queuePausedReason ? (
          <Alert color="red" variant="light" title="New runs are paused">
            <Group justify="space-between">
              <Text size="sm">
                {s.queuePausedReason} Add credits or enable AI features for the team, then resume.
              </Text>
              <Button
                size="xs"
                loading={resume.isPending}
                onClick={() => {
                  resume.mutate({})
                }}
              >
                Resume
              </Button>
            </Group>
          </Alert>
        ) : null}
        <Card p={0}>
          <div className="va-figures">
            <div>
              <div className="va-figure-label">Running now</div>
              <div className="va-figure-value">
                {s ? s.inFlight.length : '—'}
                <span style={{ color: 'var(--va-faint)', fontSize: 16 }}> / {s?.maxActiveRuns ?? '—'}</span>
              </div>
            </div>
            <div>
              <div className="va-figure-label">Queued</div>
              <div className="va-figure-value">{s ? s.queued : '—'}</div>
            </div>
            <div>
              <div className="va-figure-label">Failures, last 7 days</div>
              <div className="va-figure-value" style={{ color: failures ? 'var(--va-negative)' : undefined }}>
                {s ? failures : '—'}
              </div>
            </div>
            <div>
              <div className="va-figure-label">Credits, week of {thisWeek ?? '—'}</div>
              <div className="va-figure-value">
                {s ? weekCredits.toFixed(0) : '—'}
                {weekUnknown ? (
                  <span style={{ color: 'var(--va-faint)', fontSize: 14 }}> + unknown</span>
                ) : null}
              </div>
            </div>
          </div>
        </Card>

        <div className="va-split" data-even>
          <Card>
            <Text fw={600} mb="xs">
              Runs in flight
            </Text>
            {(s?.inFlight ?? []).length === 0 ? (
              <div className="va-empty">Nothing is running.</div>
            ) : (
              <table className="va-table">
                <thead>
                  <tr>
                    <th>Video</th>
                    <th>Stage</th>
                    <th className="num">Started</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {s?.inFlight.map((a) => (
                    <tr key={a.attemptId}>
                      <td>
                        <Anchor component={Link} to={`/videos/${a.jobId}`} c="var(--va-text)">
                          {a.title} <span style={{ color: 'var(--va-faint)' }}>v{a.versionN}</span>
                        </Anchor>
                        {a.runUrl ? (
                          <Anchor href={a.runUrl} target="_blank" size="sm" c="var(--va-muted)" ml="sm">
                            run
                          </Anchor>
                        ) : null}
                      </td>
                      <td>{STAGE[a.stage ?? ''] ?? a.stage}</td>
                      <td className="num">{a.startedAt ? relativeTime(a.startedAt) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {a.stage === 'running' || a.stage === 'starting' || a.stage === 'finding_music' ? (
                          <Button
                            size="xs"
                            variant="subtle"
                            color="red"
                            onClick={() => {
                              cancel.mutate({ params: { path: { id: a.jobId, n: a.versionN } } })
                            }}
                          >
                            Stop
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(s?.unresolved ?? []).length > 0 ? (
              <>
                <Text fw={600} mt="lg">
                  Unresolved starts
                </Text>
                <Text size="sm" c="var(--va-muted)" mb="xs">
                  The service couldn't confirm these runs started. Check the agent runs in Netlify; if none is
                  running for them, mark them failed to free the slot.
                </Text>
                <table className="va-table">
                  <tbody>
                    {s?.unresolved.map((a) => (
                      <tr key={a.attemptId}>
                        <td>
                          <Anchor component={Link} to={`/videos/${a.jobId}`} c="var(--va-text)">
                            {a.title} <span style={{ color: 'var(--va-faint)' }}>v{a.versionN}</span>
                          </Anchor>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <Button
                            size="xs"
                            variant="default"
                            onClick={() => {
                              resolve.mutate({ params: { path: { id: a.attemptId } } })
                            }}
                          >
                            Mark failed
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
          </Card>
          <Card>
            <Text fw={600} mb="xs">
              Why runs failed, last 7 days
            </Text>
            {(s?.failuresThisWeek ?? []).length === 0 ? (
              <div className="va-empty">No failures.</div>
            ) : (
              <table className="va-table">
                <tbody>
                  {[...(s?.failuresThisWeek ?? [])]
                    .sort((a, b) => b.count - a.count)
                    .map((f) => (
                      <tr key={f.category}>
                        <td>{FAILURE[f.category] ?? f.category}</td>
                        <td className="num">{f.count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="va-split" data-even>
          <Card>
            <Text fw={600} mb="xs">
              People
            </Text>
            <table className="va-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Joined</th>
                  <th>Role</th>
                  <th style={{ textAlign: 'right' }}>Active</th>
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <tr key={u.id}>
                    <td style={{ color: u.disabled ? 'var(--va-faint)' : undefined }}>
                      {u.email}
                      {u.id === me.data?.id ? <span style={{ color: 'var(--va-faint)' }}> (you)</span> : null}
                      {u.signInMethods.length > 0 ? (
                        <Text size="xs" c="var(--va-faint)">
                          {u.signInMethods.map(signInLabel).join(' · ')}
                        </Text>
                      ) : null}
                    </td>
                    <td className="num">{relativeTime(u.createdAt)}</td>
                    <td>
                      <Select
                        aria-label={`Role for ${u.email}`}
                        size="xs"
                        w={110}
                        radius="xl"
                        value={u.role}
                        data={[
                          { value: 'creator', label: 'Creator' },
                          { value: 'reviewer', label: 'Reviewer' },
                          { value: 'viewer', label: 'Viewer' },
                          { value: 'admin', label: 'Admin' },
                        ]}
                        allowDeselect={false}
                        onChange={(role) => {
                          if (role)
                            update.mutate({
                              params: { path: { id: u.id } },
                              body: { role: role },
                            })
                        }}
                      />
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Button
                        variant="subtle"
                        color="gray"
                        size="compact-xs"
                        mr="sm"
                        onClick={() => {
                          openTransfer(u)
                        }}
                      >
                        Transfer videos
                      </Button>
                      <Switch
                        aria-label={`${u.email} active`}
                        checked={!u.disabled}
                        onChange={(e) => {
                          update.mutate({
                            params: { path: { id: u.id } },
                            body: { disabled: !e.currentTarget.checked },
                          })
                        }}
                        style={{ display: 'inline-block' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Text size="xs" c="var(--va-faint)" mt="sm">
              Turning someone off also revokes their API keys. Invite people from Identity in the Netlify
              project settings.
            </Text>
          </Card>
          <WebhookCard scope="team" />
          <NarrationSettingsCard />
          <RemixSettingsCard />
          <Card>
            <Text fw={600} mb="xs">
              Credits by person
            </Text>
            {(s?.usage ?? []).length === 0 ? (
              <div className="va-empty">No runs or planning in the last 5 weeks.</div>
            ) : (
              <table className="va-table">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th>Week of</th>
                    <th className="num">Videos</th>
                    <th className="num">Run credits</th>
                    <th className="num">Planning</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(s?.usage ?? [])]
                    .sort((a, b) => b.week.localeCompare(a.week) || (b.credits ?? 0) - (a.credits ?? 0))
                    .slice(0, 8)
                    .map((u) => (
                      <tr key={`${u.userId}-${u.week}`}>
                        <td>{(u.email ?? u.userId).split('@')[0]}</td>
                        <td className="num">{u.week.slice(5)}</td>
                        <td className="num">{u.videos}</td>
                        <td className="num">{u.credits === null ? '—' : u.credits.toFixed(0)}</td>
                        <td
                          className="num"
                          title={
                            u.planningUnknown ? `${u.planningUnknown} call(s) with unknown cost` : undefined
                          }
                        >
                          {u.planningCredits.toFixed(1)}
                          {u.planningUnknown ? '+' : ''}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </Stack>
    </>
  )
}

const GIB = 1024 ** 3

/** Remixing (docs/plans/2026-11-03-remix.md §4): on by default; off hides every Remix control and refuses new ones. */
function RemixSettingsCard() {
  const afterWrite = useAfterWrite()
  const settings = $api.useQuery('get', '/api/v1/admin/settings')
  const save = $api.useMutation('patch', '/api/v1/admin/settings', afterWrite)
  const s = settings.data
  return (
    <Card>
      <Text fw={600} mb="xs">
        Remixing
      </Text>
      <Switch
        label="People can remix videos"
        description="A remix is a new video that starts from another one. Off hides Remix everywhere and refuses new remixes; remixes already queued still run."
        checked={s?.remixEnabled ?? false}
        disabled={!s}
        onChange={(e) => {
          save.mutate({ body: { remixEnabled: e.currentTarget.checked } })
        }}
      />
    </Card>
  )
}

/** Recorded voice-over: on or off, how takes are transcribed, and each person's storage for recordings. */
function NarrationSettingsCard() {
  const afterWrite = useAfterWrite()
  const settings = $api.useQuery('get', '/api/v1/admin/settings')
  const save = $api.useMutation('patch', '/api/v1/admin/settings', afterWrite)
  const s = settings.data
  const [quota, setQuota] = useState<number | string>('')
  useEffect(() => {
    if (s) setQuota(s.takeQuotaBytes / GIB)
  }, [s])
  const saveQuota = () => {
    const gib = Number(quota)
    if (s && Number.isFinite(gib) && gib > 0 && Math.round(gib * GIB) !== s.takeQuotaBytes)
      save.mutate({ body: { takeQuotaBytes: Math.round(gib * GIB) } })
  }
  return (
    <Card>
      <Text fw={600} mb="xs">
        Recorded voice-over
      </Text>
      <Stack gap="sm">
        <Switch
          label="People can record their own voice-over"
          description="Off hides recording and refuses narration changes. Videos that already have narration keep playing."
          checked={s?.narrationEnabled ?? false}
          disabled={!s}
          onChange={(e) => {
            save.mutate({ body: { narrationEnabled: e.currentTarget.checked } })
          }}
        />
        <Select
          label="Captions from recordings"
          size="sm"
          value={s?.transcriptionProvider ?? null}
          disabled={!s}
          allowDeselect={false}
          data={[
            { value: 'local', label: 'Transcribe here (recommended)' },
            { value: 'elevenlabs', label: 'ElevenLabs (sends the audio to ElevenLabs)' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(v) => {
            if (v === 'local' || v === 'elevenlabs' || v === 'off')
              save.mutate({ body: { transcriptionProvider: v } })
          }}
        />
        <NumberInput
          label="Storage for each person's recordings"
          size="sm"
          suffix=" GiB"
          min={0.01}
          max={1024}
          decimalScale={2}
          value={quota}
          disabled={!s}
          onChange={setQuota}
          onBlur={saveQuota}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveQuota()
          }}
        />
      </Stack>
    </Card>
  )
}

/** How a person signs in, as the People table shows it. */
function signInLabel(method: string): string {
  if (method === 'identity') return 'Netlify Identity'
  if (method === 'netlify') return 'Sign in with Netlify'
  return method
}
