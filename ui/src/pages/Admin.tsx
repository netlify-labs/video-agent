import { Alert, Anchor, Button, Card, Group, Select, Stack, Switch, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Navigate } from 'react-router'
import { $api, errorMessage } from '../api/client'
import { relativeTime } from '../components/bits'

const STAGE: Record<string, string> = {
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
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorMessage(e) })
  const done = () => void qc.invalidateQueries()
  const update = $api.useMutation('patch', '/api/v1/users/{id}', { onSuccess: done, onError })
  const resolve = $api.useMutation('post', '/api/v1/admin/attempts/{id}/resolve', {
    onSuccess: done,
    onError,
  })
  const resume = $api.useMutation('post', '/api/v1/admin/queue/resume', { onSuccess: done, onError })
  const cancel = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/cancel', {
    onSuccess: done,
    onError,
  })

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
      <div className="va-title-row">
        <div>
          <Title order={1}>Admin</Title>
          <div className="va-sub">{finding}</div>
        </div>
      </div>
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
                        {a.stage === 'running' || a.stage === 'starting' ? (
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
                    <td style={{ textAlign: 'right' }}>
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
          <Card>
            <Text fw={600} mb="xs">
              Credits by person
            </Text>
            {(s?.usage ?? []).length === 0 ? (
              <div className="va-empty">No runs in the last 5 weeks.</div>
            ) : (
              <table className="va-table">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th>Week of</th>
                    <th className="num">Videos</th>
                    <th className="num">Credits</th>
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
